import { decodeMulti } from '@msgpack/msgpack';
import { buildAbsoluteURL } from 'url-toolkit';
import { findFragmentByPTS } from './fragment-finders';
import { Events } from '../events';
import { PlaylistLevelType } from '../types/loader';
import {
  getLoaderConfigWithoutReties,
  getRetryDelay,
  shouldRetry,
} from '../utils/error-helper';
import type { RetryConfig } from '../config';
import type Hls from '../hls';
import type { Fragment, MediaFragment } from '../loader/fragment';
import type { LevelDetails } from '../loader/level-details';
import type {
  AipdMessage,
  AlgoChunk,
  AutoCameraItem,
  DetItem,
  FrameItem,
  TrackItem,
} from '../types/algo';
import type { NetworkComponentAPI } from '../types/component-api';
import type {
  AlgoDataErrorData,
  AlgoDataLoadedData,
  AlgoDataLoadingData,
  FragChangedData,
  FragLoadingData,
  LevelLoadedData,
  LevelUpdatedData,
} from '../types/events';
import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats,
} from '../types/loader';
import type { NullableNetworkDetails } from '../types/network-details';

class AlgoDataController implements NetworkComponentAPI {
  private hls: Hls | null;
  private currentLevelDetails: LevelDetails | null = null;
  private algoChunkCache = new Map<number, AlgoChunk>();
  private algoChunkLoading = new Map<number, Loader<LoaderContext>>();
  private algoChunkFailed = new Set<number>();
  private algoChunkRetryCount = new Map<number, number>();
  private algoChunkRetryTimer = new Map<number, number>();
  private started = false;

  constructor(hls: Hls) {
    this.hls = hls;
    this.registerListeners();
  }

  public startLoad() {
    this.started = true;
  }

  public stopLoad() {
    this.started = false;
    this.abortAllLoads();
  }

  public destroy() {
    this.unregisterListeners();
    this.abortAllLoads();
    this.resetCache();
    this.hls = null;
  }

  public getFrameByTime(time: number): FrameItem | null {
    return this.resolveFrameByTime(time);
  }

  public getFrameByIndex(frameIdx: number): FrameItem | null {
    if (!Number.isFinite(frameIdx)) {
      return null;
    }
    const chunk = this.findChunkByFrameIndex(frameIdx);
    if (!chunk) return null;
    const frameOffset = frameIdx - chunk.startFrameIndex;
    if (frameOffset < 0 || frameOffset >= chunk.frames.length) {
      return null;
    }
    return chunk.frames[frameOffset] || null;
  }

  public isDataReady(time: number): boolean {
    return this.resolveFrameByTime(time) !== null;
  }

  private resolveFrameByTime(time: number): FrameItem | null {
    const levelDetails = this.getLevelDetails();
    if (!levelDetails || !Number.isFinite(time)) {
      return null;
    }
    const frag = this.findFragmentByTime(levelDetails, time);
    if (!frag || time < frag.start) {
      return null;
    }
    const chunk = this.getChunkByFragment(frag);
    if (!chunk || !Number.isFinite(chunk.frameRate) || chunk.frameRate <= 0) {
      return null;
    }
    const frameOffset = Math.floor((time - frag.start) * chunk.frameRate);
    if (frameOffset < 0 || frameOffset >= chunk.frames.length) {
      return null;
    }
    return chunk.frames[frameOffset] || null;
  }

  public isDataReadyByIndex(frameIdx: number): boolean {
    return this.getFrameByIndex(frameIdx) !== null;
  }

  public getAllCachedChunks(): AlgoChunk[] {
    return Array.from(this.algoChunkCache.values()).sort((a, b) => {
      if (a.fragSn !== b.fragSn) return a.fragSn - b.fragSn;
      if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
      return a.startFrameIndex - b.startFrameIndex;
    });
  }

  private registerListeners() {
    const hls = this.hls;
    if (!hls) return;
    hls.on(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.on(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.on(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
    hls.on(Events.FRAG_CHANGED, this.onFragChanged, this);
    hls.on(Events.FRAG_LOADING, this.onFragLoading, this);
  }

  private unregisterListeners() {
    const hls = this.hls;
    if (!hls) return;
    hls.off(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.off(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.off(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
    hls.off(Events.FRAG_CHANGED, this.onFragChanged, this);
    hls.off(Events.FRAG_LOADING, this.onFragLoading, this);
  }

  private onManifestLoading() {
    this.resetCache();
  }

  private onLevelLoaded(event: Events.LEVEL_LOADED, data: LevelLoadedData) {
    this.currentLevelDetails = data.details;
  }

  private onLevelUpdated(event: Events.LEVEL_UPDATED, data: LevelUpdatedData) {
    this.currentLevelDetails = data.details;
  }

  private onFragChanged(event: Events.FRAG_CHANGED, data: FragChangedData) {
    if (!this.started) return;
    const frag = data.frag;
    if (frag.type !== PlaylistLevelType.MAIN) return;
    if (!this.currentLevelDetails) return;
    this.preloadFromFragment(frag as MediaFragment);
  }

  /**
   * 视频分片开始加载时，同步触发对应算法分片的加载。
   * FRAG_CHANGED 仅在播放到新分片时触发，无法覆盖提前缓冲的分片，
   * 因此需要在视频分片开始下载的同一时刻并行加载算法分片，确保一一对应。
   */
  private onFragLoading(event: Events.FRAG_LOADING, data: FragLoadingData) {
    if (!this.started) return;
    const frag = data.frag;
    if (frag.type !== PlaylistLevelType.MAIN) return;
    if (!frag.algoRelurl) return;
    this.loadAlgoChunk(frag as MediaFragment);
  }

  private preloadFromFragment(frag: MediaFragment) {
    const levelDetails = this.getLevelDetails();
    if (!levelDetails) return;
    const startIndex = this.getFragmentIndex(levelDetails, frag);
    if (startIndex < 0) return;

    const preloadCount = this.getPreloadCount();
    for (let offset = 0; offset <= preloadCount; offset += 1) {
      const target = levelDetails.fragments[startIndex + offset];
      if (!target?.algoRelurl) continue;
      this.loadAlgoChunk(target as MediaFragment);
    }
  }

  private getFragmentIndex(
    levelDetails: LevelDetails,
    frag: MediaFragment,
  ): number {
    if (typeof frag.sn === 'number') {
      const index = frag.sn - levelDetails.startSN;
      if (levelDetails.fragments[index]?.sn === frag.sn) {
        return index;
      }
    }
    return levelDetails.fragments.findIndex((item) => item?.sn === frag.sn);
  }

  private loadAlgoChunk(frag: MediaFragment) {
    if (!this.hls || !frag.algoRelurl) return;

    const key = this.getAlgoChunkKey(frag);
    if (this.shouldSkipLoad(key)) return;

    const algoUrl = this.resolveAlgoUrl(frag);
    if (!algoUrl) {
      this.reportAlgoError(frag, '', new Error('算法分片地址解析失败'));
      return;
    }

    this.startAlgoLoad(frag, algoUrl, key);
  }

  private shouldSkipLoad(key: number): boolean {
    return (
      this.algoChunkCache.has(key) ||
      this.algoChunkLoading.has(key) ||
      this.algoChunkFailed.has(key) ||
      this.algoChunkRetryTimer.has(key)
    );
  }

  private startAlgoLoad(frag: MediaFragment, algoUrl: string, key: number) {
    if (!this.started || !this.hls) return;
    const hls = this.hls as Hls;
    const loader = this.createLoader();
    const loaderConfig = this.createLoaderConfig();
    this.algoChunkLoading.set(key, loader);

    const loadingData: AlgoDataLoadingData = {
      frag,
      url: algoUrl,
    };
    hls.trigger(Events.ALGO_DATA_LOADING, loadingData);

    const callbacks = this.createAlgoCallbacks(frag, algoUrl, key, loader);
    loader.load(
      {
        responseType: 'arraybuffer',
        url: algoUrl,
      },
      loaderConfig,
      callbacks,
    );
  }

  private createAlgoCallbacks(
    frag: MediaFragment,
    algoUrl: string,
    key: number,
    loader: Loader<LoaderContext>,
  ): LoaderCallbacks<LoaderContext> {
    return {
      onSuccess: (response, stats, context, networkDetails) => {
        this.cleanupLoader(key, loader);
        this.handleAlgoLoaded(
          frag,
          algoUrl,
          response.data as ArrayBuffer,
          stats,
          networkDetails,
        );
      },
      onError: (error, context, networkDetails, stats) => {
        this.cleanupLoader(key, loader);
        const response: LoaderResponse = {
          url: context.url,
          data: undefined,
          code: error.code,
        };
        const retried = this.retryAlgoLoad(frag, algoUrl, key, false, response);
        if (retried) return;
        this.reportAlgoError(
          frag,
          algoUrl,
          new Error(
            `算法分片加载失败：HTTP ${error.code} ${error.text} (${context.url})`,
          ),
          stats,
          networkDetails,
        );
      },
      onTimeout: (stats, context, networkDetails) => {
        this.cleanupLoader(key, loader);
        const retried = this.retryAlgoLoad(frag, algoUrl, key, true);
        if (retried) return;
        this.reportAlgoError(
          frag,
          algoUrl,
          new Error(`算法分片加载超时 (${context.url})`),
          stats,
          networkDetails,
        );
      },
    };
  }

  private handleAlgoLoaded(
    frag: MediaFragment,
    algoUrl: string,
    payload: ArrayBuffer,
    stats: LoaderStats,
    networkDetails: NullableNetworkDetails,
  ) {
    const hls = this.hls;
    if (!hls) return;

    let message: AipdMessage;
    try {
      message = this.parseAipdMessage(payload);
    } catch (error) {
      this.reportAlgoError(
        frag,
        algoUrl,
        error as Error,
        stats,
        networkDetails,
      );
      return;
    }

    const chunk = this.buildAlgoChunk(frag, algoUrl, message);
    const key = this.getAlgoChunkKey(frag);
    this.algoChunkCache.set(key, chunk);
    this.clearRetryState(key);
    this.evictCache();

    const loadedData: AlgoDataLoadedData = {
      frag,
      url: algoUrl,
      chunk,
      stats,
      networkDetails,
    };
    hls.trigger(Events.ALGO_DATA_LOADED, loadedData);
  }

  private reportAlgoError(
    frag: MediaFragment,
    algoUrl: string,
    error: Error,
    stats?: LoaderStats,
    networkDetails?: NullableNetworkDetails,
  ) {
    const hls = this.hls;
    if (!hls) return;

    const key = this.getAlgoChunkKey(frag);
    this.algoChunkFailed.add(key);

    const errorData: AlgoDataErrorData = {
      frag,
      url: algoUrl,
      error,
      reason: error.message,
      stats,
      networkDetails,
    };
    hls.trigger(Events.ALGO_DATA_ERROR, errorData);
  }

  private parseAipdMessage(payload: ArrayBuffer): AipdMessage {
    const decodedItems = this.decodeMultiItems(payload);
    const root = this.extractRootFields(decodedItems);

    if (!Array.isArray(root.framesRaw)) {
      throw new Error('算法帧数据不是数组');
    }

    const frames = this.parseFrames(root.framesRaw);

    return {
      version: Number(root.version) || 0,
      chunkIndex: Number(root.chunkIndex) || 0,
      frameSize: frames.length,
      frames,
    };
  }

  private extractRootFields(decodedItems: unknown[]): {
    version: unknown;
    chunkIndex: unknown;
    framesRaw: unknown;
  } {
    // Format 1: 4 sequential msgpack values [version, chunkIndex, frameSize, frames]
    if (decodedItems.length === 4) {
      return {
        version: decodedItems[0],
        chunkIndex: decodedItems[1],
        framesRaw: decodedItems[3],
      };
    }

    // Format 2: single msgpack array [version, chunkIndex, frames] (no frameSize)
    // decodeMulti returns 1 item which is the array
    if (
      decodedItems.length === 1 &&
      Array.isArray(decodedItems[0]) &&
      decodedItems[0].length >= 3
    ) {
      const arr = decodedItems[0];
      return {
        version: arr[0],
        chunkIndex: arr[1],
        framesRaw: arr.length === 3 ? arr[2] : arr[3],
      };
    }

    throw new Error('算法数据结构不正确');
  }

  private parseFrames(framesRaw: unknown[]): FrameItem[] {
    return framesRaw.map((raw) => this.parseFrameItem(raw));
  }

  private parseFrameItem(raw: unknown): FrameItem {
    const [frameIdx, autoCameraRaw, tracksRaw, detectionsRaw] =
      this.decodeBinAsSequence(raw, '算法帧', 4);

    const autoCameras = this.parseAutoCamera(autoCameraRaw);
    const tracks = this.parseTrackList(tracksRaw);
    const detections = this.parseDetList(detectionsRaw);

    return {
      frameIdx: Number(frameIdx) || 0,
      autoCameras,
      tracks,
      detections,
    };
  }

  private parseAutoCamera(raw: unknown): AutoCameraItem {
    // Format 2: already decoded flat array [x, y, focus, r0, r1, r2, r3]
    if (Array.isArray(raw) && raw.length === 7) {
      return {
        x: Number(raw[0]) || 0,
        y: Number(raw[1]) || 0,
        focus: Number(raw[2]) || 0,
        reserved: [
          Number(raw[3]) || 0,
          Number(raw[4]) || 0,
          Number(raw[5]) || 0,
          Number(raw[6]) || 0,
        ],
      };
    }
    // Format 1: binary blob or [x, y, focus, [reserved]]
    const [x, y, focus, reserved] = this.decodeBinAsSequence(
      raw,
      '算法相机',
      4,
    );
    this.ensureFixedArray(reserved, 4, '算法相机 reserved');
    const reservedArray = (reserved as unknown[]).map((v) => Number(v) || 0);
    return {
      x: Number(x) || 0,
      y: Number(y) || 0,
      focus: Number(focus) || 0,
      reserved: reservedArray as [number, number, number, number],
    };
  }

  private parseTrackItem(raw: unknown): TrackItem {
    const [trackId, score, boxRaw, reserved] = this.decodeBinAsSequence(
      raw,
      'Track',
      4,
    );
    const box = this.parseBox(boxRaw, 'Track box');
    this.ensureFixedArray(reserved, 4, 'Track reserved');
    const reservedArray = (reserved as unknown[]).map((v) => Number(v) || 0);

    return {
      trackId: Number(trackId) || 0,
      score: Number(score) || 0,
      box,
      reserved: reservedArray as [number, number, number, number],
    };
  }

  private parseDetItem(raw: unknown): DetItem {
    const [classId, score, boxRaw, reserved] = this.decodeBinAsSequence(
      raw,
      'Det',
      4,
    );
    const box = this.parseBox(boxRaw, 'Det box');
    this.ensureFixedArray(reserved, 4, 'Det reserved');
    const reservedArray = (reserved as unknown[]).map((v) => Number(v) || 0);

    return {
      classId: Number(classId) || 0,
      score: Number(score) || 0,
      box,
      reserved: reservedArray as [number, number, number, number],
    };
  }

  private parseBox(
    raw: unknown,
    name: string,
  ): [number, number, number, number] {
    if (!Array.isArray(raw) || raw.length !== 4) {
      throw new Error(`${name} 长度不正确`);
    }
    return [
      Number(raw[0]) || 0,
      Number(raw[1]) || 0,
      Number(raw[2]) || 0,
      Number(raw[3]) || 0,
    ];
  }

  private decodeMultiItems(payload: ArrayBuffer | Uint8Array): unknown[] {
    try {
      const input =
        payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      const result = decodeMulti(input);
      return Array.isArray(result) ? result : Array.from(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`算法数据解包失败: ${reason}`);
    }
  }

  private decodeBinAsSequence(
    value: unknown,
    name: string,
    expectedLength: number,
  ): unknown[] {
    // Format 2: already decoded array
    if (Array.isArray(value)) {
      if (value.length !== expectedLength) {
        throw new Error(`${name} 结构不正确`);
      }
      return value;
    }
    // Format 1: binary blob, needs msgpack decoding
    if (!(value instanceof Uint8Array)) {
      throw new Error(`${name} 数据格式不支持`);
    }
    const items = this.decodeMultiItems(value);
    if (items.length !== expectedLength) {
      throw new Error(`${name} 结构不正确`);
    }
    return items;
  }

  private ensureFixedArray(
    value: unknown,
    length: number,
    name: string,
  ): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length !== length) {
      throw new Error(`${name} 长度不正确`);
    }
  }

  private parseTrackList(value: unknown): TrackItem[] {
    if (!Array.isArray(value)) {
      throw new Error('tracks_ 不是数组');
    }
    return value.map((item) => this.parseTrackItem(item));
  }

  private parseDetList(value: unknown): DetItem[] {
    if (!Array.isArray(value)) {
      throw new Error('detections_ 不是数组');
    }
    return value.map((item) => this.parseDetItem(item));
  }

  private buildAlgoChunk(
    frag: MediaFragment,
    algoUrl: string,
    message: AipdMessage,
  ): AlgoChunk {
    const hls = this.hls;
    const logger = hls?.logger;

    this.checkFrameSequence(message.frames, message.chunkIndex, logger);

    const frameCount = message.frames.length;
    const configFrameRate = hls?.config.algoFrameRate;
    const frameRate =
      Number.isFinite(configFrameRate) && configFrameRate! > 0
        ? (configFrameRate as number)
        : frag.duration > 0
          ? frameCount / frag.duration
          : 0;

    return {
      fragSn: typeof frag.sn === 'number' ? frag.sn : -1,
      algoUrl,
      chunkIndex: message.chunkIndex,
      frameSize: message.frameSize,
      frameRate,
      startFrameIndex: message.frames[0]?.frameIdx ?? 1,
      frames: message.frames,
    };
  }

  private checkFrameSequence(
    frames: FrameItem[],
    chunkIndex: number,
    logger?: { warn: (msg: string) => void },
  ) {
    if (frames.length <= 1) return;
    let prevIndex = frames[0]?.frameIdx ?? 0;
    for (let i = 1; i < frames.length; i += 1) {
      const current = frames[i]?.frameIdx ?? 0;
      if (current !== prevIndex + 1) {
        logger?.warn(
          `[AlgoData] 帧索引不连续，chunkIndex=${chunkIndex} prev=${prevIndex} current=${current}`,
        );
        break;
      }
      prevIndex = current;
    }
  }

  private getChunkByFragment(frag: MediaFragment): AlgoChunk | null {
    const key = this.getAlgoChunkKey(frag);
    return this.algoChunkCache.get(key) || null;
  }

  private findChunkByFrameIndex(frameIdx: number): AlgoChunk | null {
    const chunks = Array.from(this.algoChunkCache.values());
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const frameSize =
        Number.isFinite(chunk.frameSize) && chunk.frameSize > 0
          ? chunk.frameSize
          : chunk.frames.length;
      const start = chunk.startFrameIndex ?? 1;
      const end = start + frameSize - 1;
      if (frameIdx >= start && frameIdx <= end) {
        return chunk;
      }
    }
    return null;
  }

  private findFragmentByTime(
    levelDetails: LevelDetails,
    time: number,
  ): MediaFragment | null {
    const fragments = levelDetails.fragments.filter(Boolean) as MediaFragment[];
    const maxFragLookUpTolerance = this.hls?.config.maxFragLookUpTolerance ?? 0;
    return findFragmentByPTS(null, fragments, time, maxFragLookUpTolerance);
  }

  private getAlgoChunkKey(frag: Fragment): number {
    if (typeof frag.sn === 'number') {
      return frag.sn;
    }
    return Math.round(frag.start * 1000);
  }

  private resolveAlgoUrl(frag: MediaFragment): string | null {
    if (!frag.algoRelurl) return null;
    return buildAbsoluteURL(frag.baseurl, frag.algoRelurl, {
      alwaysNormalize: true,
    });
  }

  private createLoader(): Loader<LoaderContext> {
    const hls = this.hls as Hls;
    const Loader = hls.config.loader;
    return new Loader(hls.config) as Loader<LoaderContext>;
  }

  private createLoaderConfig(): LoaderConfiguration {
    const hls = this.hls as Hls;
    const loadPolicy = getLoaderConfigWithoutReties(
      hls.config.fragLoadPolicy.default,
    );
    return {
      loadPolicy,
      timeout: loadPolicy.maxLoadTimeMs,
      maxRetry: 0,
      retryDelay: 0,
      maxRetryDelay: 0,
    };
  }

  private getPreloadCount(): number {
    const value = this.hls?.config.algoPreloadCount ?? 0;
    return Math.max(0, Math.floor(value));
  }

  private evictCache() {
    const configSize = this.hls?.config.algoCacheSize ?? 0;
    if (configSize <= 0) return;
    const maxSize = Math.max(1, Math.floor(configSize));
    if (this.algoChunkCache.size <= maxSize) return;
    while (this.algoChunkCache.size > maxSize) {
      const firstKey = this.algoChunkCache.keys().next().value;
      if (firstKey === undefined) break;
      this.algoChunkCache.delete(firstKey);
    }
  }

  private abortAllLoads() {
    this.algoChunkLoading.forEach((loader) => {
      loader.abort();
      loader.destroy();
    });
    this.algoChunkLoading.clear();
    this.clearAllRetryTimers();
  }

  private cleanupLoader(key: number, loader: Loader<LoaderContext>) {
    const current = this.algoChunkLoading.get(key);
    if (current === loader) {
      this.algoChunkLoading.delete(key);
    }
    loader.destroy();
  }

  private resetCache() {
    this.abortAllLoads();
    this.algoChunkCache.clear();
    this.algoChunkFailed.clear();
    this.algoChunkRetryCount.clear();
  }

  private getLevelDetails(): LevelDetails | null {
    return this.currentLevelDetails || this.hls?.latestLevelDetails || null;
  }

  private getRetryConfig(isTimeout: boolean): RetryConfig | null {
    const loadPolicy = this.hls?.config.fragLoadPolicy.default;
    if (!loadPolicy) return null;
    return isTimeout ? loadPolicy.timeoutRetry : loadPolicy.errorRetry;
  }

  private retryAlgoLoad(
    frag: MediaFragment,
    algoUrl: string,
    key: number,
    isTimeout: boolean,
    response?: LoaderResponse,
  ): boolean {
    const retryConfig = this.getRetryConfig(isTimeout);
    if (!retryConfig) return false;
    const retryCount = this.algoChunkRetryCount.get(key) ?? 0;
    if (!shouldRetry(retryConfig, retryCount, isTimeout, response)) {
      return false;
    }
    const delay = getRetryDelay(retryConfig, retryCount);
    this.algoChunkRetryCount.set(key, retryCount + 1);
    this.clearRetryTimer(key);
    const timer = self.setTimeout(() => {
      this.algoChunkRetryTimer.delete(key);
      this.startAlgoLoad(frag, algoUrl, key);
    }, delay);
    this.algoChunkRetryTimer.set(key, timer);
    this.hls?.logger?.warn(
      `[AlgoData] 算法分片加载失败，准备重试(${retryCount + 1}/${retryConfig.maxNumRetry}) ${delay}ms: ${algoUrl}`,
    );
    return true;
  }

  private clearRetryTimer(key: number) {
    const timer = this.algoChunkRetryTimer.get(key);
    if (timer === undefined) return;
    self.clearTimeout(timer);
    this.algoChunkRetryTimer.delete(key);
  }

  private clearAllRetryTimers() {
    this.algoChunkRetryTimer.forEach((timer) => {
      self.clearTimeout(timer);
    });
    this.algoChunkRetryTimer.clear();
  }

  private clearRetryState(key: number) {
    this.algoChunkRetryCount.delete(key);
    this.clearRetryTimer(key);
    this.algoChunkFailed.delete(key);
  }
}

export default AlgoDataController;
