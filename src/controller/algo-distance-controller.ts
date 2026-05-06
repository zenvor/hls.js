import { decodeMulti } from '@msgpack/msgpack';
import { buildAbsoluteURL } from 'url-toolkit';
import { Events } from '../events';
import {
  getLoaderConfigWithoutReties,
  getRetryDelay,
  shouldRetry,
} from '../utils/error-helper';
import type { RetryConfig } from '../config';
import type Hls from '../hls';
import type { LevelDetails } from '../loader/level-details';
import type { AlgoDistanceData } from '../types/algo';
import type { NetworkComponentAPI } from '../types/component-api';
import type {
  AlgoDistanceErrorData,
  AlgoDistanceLoadedData,
  AlgoDistanceLoadingData,
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

/**
 * 加载/解码流级一次性 algo_distance.ts 元数据分片。
 *
 * 设计要点：
 * - 受 `config.algoDataEnabled` 控制，在 Hls 构造时与 AlgoDataController 一同启用。
 * - 监听 `MANIFEST_LOADING` 清空状态；监听 `LEVEL_LOADED / LEVEL_UPDATED` 探测
 *   `level.algoDistanceRelurl`，命中新路径才发起加载（OSS 签名 URL 的 query 部分
 *   会随刷新变化，按路径去重）。
 * - 双轨 API：事件 ALGO_DISTANCE_LOADING/LOADED/ERROR + 同步 getter
 *   `getDistance / isReady`。事件不做幂等重放，新订阅者请用 getter 取快照。
 */
class AlgoDistanceController implements NetworkComponentAPI {
  private hls: Hls | null;
  private currentLevelDetails: LevelDetails | null = null;
  private currentDistance: AlgoDistanceData | null = null;
  private currentDistanceKey: string | null = null;
  private currentLoader: Loader<LoaderContext> | null = null;
  private retryCount = 0;
  private retryTimer: number | null = null;
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
    this.abortLoad();
  }

  public destroy() {
    this.unregisterListeners();
    this.abortLoad();
    this.resetCache();
    this.hls = null;
  }

  /**
   * 同步获取已加载的测距元数据，未加载时返回 null。
   */
  public getDistance(): AlgoDistanceData | null {
    return this.currentDistance;
  }

  public isReady(): boolean {
    return this.currentDistance !== null;
  }

  private registerListeners() {
    const hls = this.hls;
    if (!hls) return;
    hls.on(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.on(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.on(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
  }

  private unregisterListeners() {
    const hls = this.hls;
    if (!hls) return;
    hls.off(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.off(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.off(Events.LEVEL_UPDATED, this.onLevelUpdated, this);
  }

  private onManifestLoading() {
    // 新的 manifest 加载视为新流；清空一切（含已加载的 distance）
    this.resetCache();
  }

  private onLevelLoaded(event: Events.LEVEL_LOADED, data: LevelLoadedData) {
    this.currentLevelDetails = data.details;
    this.maybeLoadDistance(data.details);
  }

  private onLevelUpdated(event: Events.LEVEL_UPDATED, data: LevelUpdatedData) {
    this.currentLevelDetails = data.details;
    this.maybeLoadDistance(data.details);
  }

  private maybeLoadDistance(details: LevelDetails) {
    if (!this.started || !this.hls) return;
    const relurl = details.algoDistanceRelurl;
    if (!relurl) return;
    const key = this.getDistanceKey(relurl);
    // 同一路径（成功/失败/在飞 任一状态）已处理过 → 跳过。
    // 与 AlgoDataController 一致：MANIFEST 重新加载才允许重试，避免在
    // playlist refresh 时反复打无效请求。
    if (this.currentDistanceKey === key) return;

    const absoluteUrl = buildAbsoluteURL(details.url, relurl, {
      alwaysNormalize: true,
    });
    if (!absoluteUrl) {
      this.reportError('', new Error('algo_distance 分片地址解析失败'));
      return;
    }

    this.abortLoad();
    this.currentDistanceKey = key;
    this.currentDistance = null;
    this.retryCount = 0;
    this.startDistanceLoad(absoluteUrl);
  }

  private getDistanceKey(relurl: string): string {
    // OSS 签名 URL 的 query 部分会随刷新变化，按路径去重
    return relurl.split(/[?#]/)[0];
  }

  private startDistanceLoad(url: string) {
    if (!this.started || !this.hls) return;
    const hls = this.hls;
    const loader = this.createLoader();
    const loaderConfig = this.createLoaderConfig();
    this.currentLoader = loader;

    const loadingData: AlgoDistanceLoadingData = { url };
    hls.trigger(Events.ALGO_DISTANCE_LOADING, loadingData);

    const callbacks = this.createCallbacks(url, loader);
    loader.load(
      {
        responseType: 'arraybuffer',
        url,
      },
      loaderConfig,
      callbacks,
    );
  }

  private createCallbacks(
    url: string,
    loader: Loader<LoaderContext>,
  ): LoaderCallbacks<LoaderContext> {
    return {
      onSuccess: (response, stats, context, networkDetails) => {
        this.cleanupLoader(loader);
        this.handleLoaded(
          url,
          response.data as ArrayBuffer,
          stats,
          networkDetails,
        );
      },
      onError: (error, context, networkDetails, stats) => {
        this.cleanupLoader(loader);
        const response: LoaderResponse = {
          url: context.url,
          data: undefined,
          code: error.code,
        };
        const retried = this.retryLoad(url, false, response);
        if (retried) return;
        this.reportError(
          url,
          new Error(
            `algo_distance 分片加载失败：HTTP ${error.code} ${error.text} (${context.url})`,
          ),
          stats,
          networkDetails,
        );
      },
      onTimeout: (stats, context, networkDetails) => {
        this.cleanupLoader(loader);
        const retried = this.retryLoad(url, true);
        if (retried) return;
        this.reportError(
          url,
          new Error(`algo_distance 分片加载超时 (${context.url})`),
          stats,
          networkDetails,
        );
      },
    };
  }

  private handleLoaded(
    url: string,
    payload: ArrayBuffer,
    stats: LoaderStats,
    networkDetails: NullableNetworkDetails,
  ) {
    const hls = this.hls;
    if (!hls) return;

    let distance: AlgoDistanceData;
    try {
      distance = this.parseDistance(payload);
    } catch (error) {
      this.reportError(url, error as Error, stats, networkDetails);
      return;
    }

    this.currentDistance = distance;
    this.retryCount = 0;
    this.clearRetryTimer();

    const loadedData: AlgoDistanceLoadedData = {
      url,
      distance,
      networkDetails,
      stats,
    };
    hls.trigger(Events.ALGO_DISTANCE_LOADED, loadedData);
  }

  private parseDistance(payload: ArrayBuffer): AlgoDistanceData {
    const decoded = this.decodeMultiItems(payload);
    // 原始数据外层为 fixarray(5)，decodeMulti 在单顶层对象时返回 1 个元素
    const root = decoded.length === 1 ? decoded[0] : decoded;
    if (!Array.isArray(root) || root.length < 5) {
      throw new Error('algo_distance 数据结构不正确（期望 fixarray(5)）');
    }
    const matrixRaw = root[3];
    if (!Array.isArray(matrixRaw) || matrixRaw.length !== 9) {
      throw new Error('algo_distance 矩阵长度不正确（期望 9 元素）');
    }
    const matrix = matrixRaw.map((v) => Number(v) || 0);
    return {
      matrix,
      raw: root as unknown[],
    };
  }

  private decodeMultiItems(payload: ArrayBuffer | Uint8Array): unknown[] {
    try {
      const input =
        payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      const result = decodeMulti(input);
      return Array.isArray(result) ? result : Array.from(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`algo_distance 数据解包失败: ${reason}`);
    }
  }

  private reportError(
    url: string,
    error: Error,
    stats?: LoaderStats,
    networkDetails?: NullableNetworkDetails,
  ) {
    const hls = this.hls;
    if (!hls) return;

    const errorData: AlgoDistanceErrorData = {
      url,
      error,
      reason: error.message,
      stats,
      networkDetails,
    };
    hls.trigger(Events.ALGO_DISTANCE_ERROR, errorData);
  }

  private retryLoad(
    url: string,
    isTimeout: boolean,
    response?: LoaderResponse,
  ): boolean {
    const retryConfig = this.getRetryConfig(isTimeout);
    if (!retryConfig) return false;
    if (!shouldRetry(retryConfig, this.retryCount, isTimeout, response)) {
      return false;
    }
    const delay = getRetryDelay(retryConfig, this.retryCount);
    this.retryCount += 1;
    this.clearRetryTimer();
    const timer = self.setTimeout(() => {
      this.retryTimer = null;
      this.startDistanceLoad(url);
    }, delay);
    this.retryTimer = timer;
    this.hls?.logger?.warn(
      `[AlgoDistance] 加载失败，准备重试(${this.retryCount}/${retryConfig.maxNumRetry}) ${delay}ms: ${url}`,
    );
    return true;
  }

  private getRetryConfig(isTimeout: boolean): RetryConfig | null {
    const loadPolicy = this.hls?.config.fragLoadPolicy.default;
    if (!loadPolicy) return null;
    return isTimeout ? loadPolicy.timeoutRetry : loadPolicy.errorRetry;
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

  private cleanupLoader(loader: Loader<LoaderContext>) {
    if (this.currentLoader === loader) {
      this.currentLoader = null;
    }
    loader.destroy();
  }

  private abortLoad() {
    if (this.currentLoader) {
      this.currentLoader.abort();
      this.currentLoader.destroy();
      this.currentLoader = null;
    }
    this.clearRetryTimer();
  }

  private clearRetryTimer() {
    if (this.retryTimer !== null) {
      self.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private resetCache() {
    this.abortLoad();
    this.currentLevelDetails = null;
    this.currentDistance = null;
    this.currentDistanceKey = null;
    this.retryCount = 0;
  }
}

export default AlgoDistanceController;
