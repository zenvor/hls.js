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

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * 加载/解码流级一次性 algo_distance.ts 元数据分片。
 *
 * 设计要点：
 * - 受 `config.algoDataEnabled` 控制，在 Hls 构造时与 AlgoDataController 一同启用。
 * - 监听 `MANIFEST_LOADING` 清空状态；监听 `LEVEL_LOADED / LEVEL_UPDATED` 探测
 *   `level.algoDistanceRelurl`，命中新路径才发起加载。去重键使用 absolute URL 的
 *   pathname，剔除 OSS 签名等 query 不参与去重。
 * - 状态机：`idle | loading | loaded | failed`。
 *   - `loaded`：永久幂等跳过；
 *   - `loading`：跳过新触发；
 *   - `failed`：当看到新 `LevelDetails` 引用时允许新一轮重试（每轮自身仍受
 *     `fragLoadPolicy.default` 的 retryConfig 上限约束），覆盖签名过期、临时网络
 *     抖动等可恢复场景。
 * - 双轨 API：事件 ALGO_DISTANCE_LOADING/LOADED/ERROR + 同步 getter
 *   `getDistance / isReady`。事件不做幂等重放，新订阅者请用 getter 取快照。
 *   返回的 `AlgoDistanceData` 及其 `matrix / raw` 在加载成功时 deep-freeze，
 *   消费者修改不会影响内部缓存。
 */
class AlgoDistanceController implements NetworkComponentAPI {
  private hls: Hls | null;
  private currentDistance: AlgoDistanceData | null = null;
  /** 已处理过的去重键，由 absolute URL 的 pathname 派生 */
  private currentDistanceKey: string | null = null;
  private loadStatus: LoadStatus = 'idle';
  /** 失败时记录引发该次加载的 details 引用，用于在新 details 进来时放行重试 */
  private lastFailedDetails: LevelDetails | null = null;
  /** 当前 in-flight 加载所对应的 details 引用 */
  private currentLoadDetails: LevelDetails | null = null;
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
   * 返回对象已 deep-freeze，可直接读但不可写。
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
    this.maybeLoadDistance(data.details);
  }

  private onLevelUpdated(event: Events.LEVEL_UPDATED, data: LevelUpdatedData) {
    this.maybeLoadDistance(data.details);
  }

  private maybeLoadDistance(details: LevelDetails) {
    if (!this.started || !this.hls) return;
    const relurl = details.algoDistanceRelurl;
    if (!relurl) return;

    const absoluteUrl = buildAbsoluteURL(details.url, relurl, {
      alwaysNormalize: true,
    });
    if (!absoluteUrl) {
      this.reportError('', new Error('algo_distance 分片地址解析失败'));
      return;
    }
    const key = this.deriveKey(absoluteUrl);

    if (this.currentDistanceKey === key) {
      // 同 key 已处理，按状态决定是否放行：
      // - loaded / loading：跳过；
      // - failed：仅当 details 引用变化（即又一次 playlist 解析）才允许重试；
      // - idle：fallthrough 允许重新加载（覆盖 stopLoad 中断 in-flight 后再
      //   startLoad 的恢复路径——abortLoad 会把 loading 态回退为 idle）。
      if (this.loadStatus === 'loaded' || this.loadStatus === 'loading') return;
      if (this.loadStatus === 'failed' && this.lastFailedDetails === details) {
        return;
      }
    }

    // 进入新一轮：取消任何 in-flight，重置计数与失败标记
    this.abortLoad();
    this.currentDistanceKey = key;
    this.currentDistance = null;
    this.retryCount = 0;
    this.lastFailedDetails = null;
    this.currentLoadDetails = details;
    this.startDistanceLoad(absoluteUrl);
  }

  /**
   * 用 absolute URL 的 pathname 做去重键，剔除 query / hash。
   * 这样 OSS 签名刷新（同路径不同 signature）不会触发重复请求；
   * 多 level / 多 CDN 域名下同名子文件也能稳定识别。
   *
   * `buildAbsoluteURL` 若返回非空字符串通常 `new URL` 都能解析，
   * fallback 仅作防御兜底（极端非法输入时退化为 substring 截取），
   * 正常路径几乎不可达。
   */
  private deriveKey(absoluteUrl: string): string {
    try {
      return new URL(absoluteUrl).pathname;
    } catch {
      return absoluteUrl.split(/[?#]/)[0];
    }
  }

  private startDistanceLoad(url: string) {
    if (!this.started || !this.hls) return;
    const hls = this.hls;
    const loader = this.createLoader();
    const loaderConfig = this.createLoaderConfig();
    this.currentLoader = loader;
    this.loadStatus = 'loading';

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
        // 世代守卫：abort/destroy/MANIFEST_LOADING 后到达的旧回调直接忽略，
        // 避免污染当前缓存；自定义不规范 loader 也在此兜底。
        if (!this.isCurrentGeneration(loader)) {
          loader.destroy();
          return;
        }
        this.cleanupLoader(loader);
        this.handleLoaded(
          url,
          response.data as ArrayBuffer,
          stats,
          networkDetails,
        );
      },
      onError: (error, context, networkDetails, stats) => {
        if (!this.isCurrentGeneration(loader)) {
          loader.destroy();
          return;
        }
        this.cleanupLoader(loader);
        const response: LoaderResponse = {
          url: context.url,
          data: undefined,
          code: error.code,
        };
        const retried = this.retryLoad(url, false, response);
        if (retried) return;
        this.markFailed();
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
        if (!this.isCurrentGeneration(loader)) {
          loader.destroy();
          return;
        }
        this.cleanupLoader(loader);
        const retried = this.retryLoad(url, true);
        if (retried) return;
        this.markFailed();
        this.reportError(
          url,
          new Error(`algo_distance 分片加载超时 (${context.url})`),
          stats,
          networkDetails,
        );
      },
    };
  }

  /** 当前 in-flight 才认是当代回调 */
  private isCurrentGeneration(loader: Loader<LoaderContext>): boolean {
    return this.started && this.hls !== null && this.currentLoader === loader;
  }

  private markFailed() {
    this.loadStatus = 'failed';
    this.lastFailedDetails = this.currentLoadDetails;
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
      this.markFailed();
      this.reportError(url, error as Error, stats, networkDetails);
      return;
    }

    this.currentDistance = distance;
    this.loadStatus = 'loaded';
    this.lastFailedDetails = null;
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
    // 严格期望 5 元，但放宽为 ">= 5" 以便算法侧未来扩展（新增字段不破坏旧消费者）。
    // 多余字段会原样保留在 raw 里。
    if (!Array.isArray(root) || root.length < 5) {
      throw new Error('algo_distance 数据结构不正确（期望 fixarray(5)）');
    }
    const matrixRaw = root[3];
    // 当前观察到服务端用 array 编码 9 个 float64；若未来切到 bin8 (Uint8Array)
    // 编码 72 字节，这里会抛清晰错误，由算法侧/前端协商再扩展解析。
    if (!Array.isArray(matrixRaw) || matrixRaw.length !== 9) {
      throw new Error('algo_distance 矩阵长度不正确（期望 9 元素）');
    }
    // 严格按 msgpack 合约（9 个 float64）校验每个元素：必须是真实 number 且
    // 有限。非数字类型（null/bool/BigInt/string）以及 NaN/Infinity 都视为
    // 协议异常，不可静默归零——否则与 placeholder 全零矩阵在外观上无法区分，
    // 会让算法距离计算静默失效，难以排查。
    const matrix = matrixRaw.map((v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(
          `algo_distance 矩阵包含非法值（期望有限 number）：${String(v)}`,
        );
      }
      return v;
    });
    const raw = root as unknown[];
    // deep-freeze：包含 raw 顶层、raw[3]（矩阵源数组）、raw[4]（meta 数组）等
    // 所有嵌套数组/对象，确保消费者无法通过 `data.raw[4][0] = ...` 之类污染缓存。
    return this.deepFreeze({
      matrix,
      raw,
    });
  }

  /**
   * 递归冻结对象/数组及其嵌套元素。已冻结的会被跳过；
   * 非对象（number/string/boolean/null/undefined）原样返回。
   */
  private deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (Object.isFrozen(value)) return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        this.deepFreeze(value[i]);
      }
    } else {
      const obj = value as Record<string, unknown>;
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          this.deepFreeze(obj[k]);
        }
      }
    }
    return Object.freeze(value);
  }

  /** v2.8 的 decodeMulti 返回 Generator；用 Array.from 物化成数组。 */
  private decodeMultiItems(payload: ArrayBuffer | Uint8Array): unknown[] {
    try {
      const input =
        payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      return Array.from(decodeMulti(input));
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
    // in-flight 加载被打断 → 回到 idle 让后续 startLoad / 同 details 能重新触发；
    // loaded / failed 是终态（成功幂等 / 失败由 lastFailedDetails 控制重试），
    // 不应被 abort 改写。
    if (this.loadStatus === 'loading') {
      this.loadStatus = 'idle';
    }
  }

  private clearRetryTimer() {
    if (this.retryTimer !== null) {
      self.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private resetCache() {
    this.abortLoad();
    this.currentDistance = null;
    this.currentDistanceKey = null;
    this.loadStatus = 'idle';
    this.lastFailedDetails = null;
    this.currentLoadDetails = null;
    this.retryCount = 0;
  }
}

export default AlgoDistanceController;
