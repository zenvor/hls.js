import { encode } from '@msgpack/msgpack';
import { expect } from 'chai';
import { hlsDefaultConfig } from '../../../src/config';
import AlgoDistanceController from '../../../src/controller/algo-distance-controller';
import { Events } from '../../../src/events';
import { LevelDetails } from '../../../src/loader/level-details';
import type { AlgoDistanceData } from '../../../src/types/algo';

describe('AlgoDistanceController', function () {
  function createHls(triggerCalls?: Array<[string, any]>) {
    // 仅模拟本测试集需要的 on/off/trigger + context 绑定语义；
    // 不实现 once / removeAllListeners 等真实 hls.on 完整 API。
    const listeners = new Map<string, Array<{ fn: any; ctx: any }>>();
    const config: any = {
      ...hlsDefaultConfig,
    };
    const hls: any = {
      config,
      logger: { warn: () => {} },
      on: (event: string, fn: any, ctx?: any) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push({ fn, ctx });
      },
      off: (event: string, fn: any, ctx?: any) => {
        const arr = listeners.get(event);
        if (!arr) return;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].fn === fn && arr[i].ctx === ctx) {
            arr.splice(i, 1);
            break;
          }
        }
      },
      trigger: (event: string, data: any) => {
        triggerCalls?.push([event, data]);
        const arr = listeners.get(event);
        if (!arr) return;
        // 复制一份避免回调期间监听集合被修改
        [...arr].forEach(({ fn, ctx }) => fn.call(ctx, event, data));
      },
    };
    return { hls };
  }

  function createController(triggerCalls?: Array<[string, any]>) {
    const { hls } = createHls(triggerCalls);
    return new AlgoDistanceController(hls);
  }

  function toArrayBuffer(view: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(view.byteLength);
    new Uint8Array(buffer).set(view);
    return buffer;
  }

  function buildPayload(
    overrides: {
      version?: number;
      flag1?: boolean;
      flag2?: boolean;
      matrix?: number[];
      meta?: unknown[];
      extra?: unknown[];
    } = {},
  ): ArrayBuffer {
    const {
      version = 1,
      flag1 = false,
      flag2 = true,
      matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0],
      meta = [
        7680,
        2160,
        1920,
        1080,
        0.0,
        30.0,
        0.5,
        180.0,
        50.625,
        3840,
        1080,
        8.0,
        81,
        998,
        true,
      ],
      extra = [],
    } = overrides;
    const root = [version, flag1, flag2, matrix, meta, ...extra];
    return toArrayBuffer(encode(root));
  }

  describe('public getters', function () {
    it('returns null and false before any data is loaded', function () {
      const controller = createController();
      expect(controller.getDistance()).to.equal(null);
      expect(controller.isReady()).to.equal(false);
    });

    it('returns the injected distance after manual cache write', function () {
      const controller = createController();
      const distance: AlgoDistanceData = {
        matrix: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        raw: [1, false, true, [1, 2, 3, 4, 5, 6, 7, 8, 9], []],
      };
      (controller as any).currentDistance = distance;

      expect(controller.getDistance()).to.equal(distance);
      expect(controller.isReady()).to.equal(true);
    });
  });

  describe('parseDistance', function () {
    it('decodes a valid fixarray(5) payload and exposes the matrix', function () {
      const controller = createController();
      const payload = buildPayload({
        matrix: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      });

      const result: AlgoDistanceData = (controller as any).parseDistance(
        payload,
      );

      expect(result.matrix).to.have.lengthOf(9);
      expect([...result.matrix]).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(result.raw).to.have.lengthOf(5);
      expect(result.raw[0]).to.equal(1);
      expect(result.raw[1]).to.equal(false);
      expect(result.raw[2]).to.equal(true);
    });

    it('deep-freezes the returned data, matrix, raw, and nested arrays', function () {
      const controller = createController();
      const payload = buildPayload({ matrix: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
      const result: AlgoDistanceData = (controller as any).parseDistance(
        payload,
      );

      // 顶层 + matrix + raw 都冻结
      expect(Object.isFrozen(result)).to.equal(true);
      expect(Object.isFrozen(result.matrix)).to.equal(true);
      expect(Object.isFrozen(result.raw)).to.equal(true);
      // 嵌套数组（raw[3] = matrix 源数据；raw[4] = meta 数组）也必须冻结，
      // 否则 `data.raw[4][0] = 999` 之类的写入会污染 controller 缓存。
      expect(Object.isFrozen(result.raw[3])).to.equal(true);
      expect(Object.isFrozen(result.raw[4])).to.equal(true);
    });

    it('accepts trailing fields beyond fixarray(5) for forward compatibility', function () {
      const controller = createController();
      const payload = buildPayload({ extra: ['future-field', 42] });

      const result: AlgoDistanceData = (controller as any).parseDistance(
        payload,
      );

      expect(result.matrix).to.have.lengthOf(9);
      expect(result.raw.length).to.be.greaterThanOrEqual(5);
    });

    it('throws when root is shorter than fixarray(5)', function () {
      const controller = createController();
      const payload = toArrayBuffer(encode([1, false, true])); // length 3

      expect(() => (controller as any).parseDistance(payload)).to.throw(
        /数据结构不正确/,
      );
    });

    it('throws when matrix length is not 9', function () {
      const controller = createController();
      const payload = buildPayload({ matrix: [0, 0, 0] });

      expect(() => (controller as any).parseDistance(payload)).to.throw(
        /矩阵长度不正确/,
      );
    });

    it('throws when matrix is encoded as Uint8Array (bin8) instead of array', function () {
      // 当前合约要求 array 编码 9 个 number；若服务端切到 bin8 应抛清晰错误，
      // 由协商后再扩展。
      const controller = createController();
      const matrixBytes = new Uint8Array(72); // 9 * 8 bytes float64
      const root = [1, false, true, matrixBytes, [0]];
      const payload = toArrayBuffer(encode(root));

      expect(() => (controller as any).parseDistance(payload)).to.throw(
        /矩阵长度不正确/,
      );
    });

    it('throws when matrix contains non-number or non-finite values', function () {
      // 三类语义异常都必须显式抛错，而非静默归零：
      //   - 非数字字符串 'oops'：违反 number 类型契约
      //   - null：msgpack nil 类型，不是 number
      //   - NaN：number 但非有限值
      // 否则与全零 placeholder 矩阵在外观上无法区分，距离计算会悄然失效。
      const badValues: unknown[] = ['oops', null, NaN];
      badValues.forEach((bad) => {
        const controller = createController();
        const root = [1, false, true, [1, 2, 3, 4, 5, 6, 7, 8, bad], [0]];
        const payload = toArrayBuffer(encode(root));

        expect(
          () => (controller as any).parseDistance(payload),
          `bad value ${String(bad)} should throw`,
        ).to.throw(/矩阵包含非法值/);
      });
    });

    it('throws when payload is not a valid msgpack stream', function () {
      const controller = createController();
      const payload = toArrayBuffer(new Uint8Array([0xc1, 0xc1, 0xc1, 0xc1]));

      expect(() => (controller as any).parseDistance(payload)).to.throw(
        /数据解包失败/,
      );
    });
  });

  describe('lifecycle hooks', function () {
    it('resets state on MANIFEST_LOADING', function () {
      const controller = createController();
      (controller as any).currentDistance = {
        matrix: [],
        raw: [],
      };
      (controller as any).currentDistanceKey = '/foo';
      (controller as any).loadStatus = 'loaded';
      (controller as any).retryCount = 3;

      (controller as any).onManifestLoading();

      expect(controller.getDistance()).to.equal(null);
      expect((controller as any).currentDistanceKey).to.equal(null);
      expect((controller as any).loadStatus).to.equal('idle');
      expect((controller as any).retryCount).to.equal(0);
    });

    it('skips loading when level has no algoDistanceRelurl', function () {
      const controller = createController();
      (controller as any).started = true;
      const details = new LevelDetails('http://example.com/level.m3u8');

      (controller as any).maybeLoadDistance(details);

      expect((controller as any).currentDistanceKey).to.equal(null);
      expect((controller as any).currentLoader).to.equal(null);
    });

    it('uses absolute pathname as the dedup key', function () {
      const controller = createController();
      (controller as any).started = true;
      (controller as any).startDistanceLoad = () => {};

      const details = new LevelDetails('http://cdn.example.com/sv/level.m3u8');
      details.algoDistanceRelurl = 'algo_distance.ts?signature=AAA';
      (controller as any).maybeLoadDistance(details);

      expect((controller as any).currentDistanceKey).to.equal(
        '/sv/algo_distance.ts',
      );
    });

    it('dedupes loads with the same path even when query string changes', function () {
      const controller = createController();
      (controller as any).started = true;
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
        (controller as any).loadStatus = 'loading';
      };

      const detailsA = new LevelDetails('http://example.com/level.m3u8');
      detailsA.algoDistanceRelurl = 'sub/algo_distance.ts?signature=AAA';
      (controller as any).maybeLoadDistance(detailsA);

      const detailsB = new LevelDetails('http://example.com/level.m3u8');
      detailsB.algoDistanceRelurl = 'sub/algo_distance.ts?signature=BBB';
      (controller as any).maybeLoadDistance(detailsB);

      expect(startedUrls).to.have.lengthOf(1);
      expect((controller as any).currentDistanceKey).to.equal(
        '/sub/algo_distance.ts',
      );
    });

    it('starts a new load when the path key changes', function () {
      const controller = createController();
      (controller as any).started = true;
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
        (controller as any).loadStatus = 'loading';
      };

      const detailsA = new LevelDetails('http://example.com/a/level.m3u8');
      detailsA.algoDistanceRelurl = 'algo_distance.ts';
      (controller as any).maybeLoadDistance(detailsA);

      const detailsB = new LevelDetails('http://example.com/b/level.m3u8');
      detailsB.algoDistanceRelurl = 'other_distance.ts';
      (controller as any).maybeLoadDistance(detailsB);

      expect(startedUrls).to.have.lengthOf(2);
      expect((controller as any).currentDistanceKey).to.equal(
        '/b/other_distance.ts',
      );
    });

    it('ignores load attempts when not started', function () {
      const controller = createController();
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
      };
      const details = new LevelDetails('http://example.com/level.m3u8');
      details.algoDistanceRelurl = 'algo_distance.ts';

      (controller as any).maybeLoadDistance(details);

      expect(startedUrls).to.have.lengthOf(0);
    });

    it('resumes loading after stopLoad/startLoad on the same details', function () {
      // 防 M1 回归：stopLoad 中断 in-flight 后 startLoad，应能重新触发同 details 的加载，
      // 而不是被 loadStatus='loading' 残留卡死永久跳过。
      const controller = createController();
      controller.startLoad();
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
        (controller as any).loadStatus = 'loading';
      };

      const details = new LevelDetails('http://example.com/level.m3u8');
      details.algoDistanceRelurl = 'algo_distance.ts';

      // 启动加载 → in-flight
      (controller as any).maybeLoadDistance(details);
      expect(startedUrls).to.have.lengthOf(1);
      expect((controller as any).loadStatus).to.equal('loading');

      // stopLoad 中断 → loadStatus 应回退为 idle
      controller.stopLoad();
      expect((controller as any).loadStatus).to.equal('idle');

      // startLoad 恢复 + 同 details 触发 → 必须能重新加载
      controller.startLoad();
      (controller as any).maybeLoadDistance(details);
      expect(startedUrls).to.have.lengthOf(2);
    });

    it('skips when loaded; allows retry on failed when details reference changes', function () {
      const controller = createController();
      (controller as any).started = true;
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
      };

      const detailsA = new LevelDetails('http://example.com/level.m3u8');
      detailsA.algoDistanceRelurl = 'algo_distance.ts';

      // 第一次加载：触发
      (controller as any).maybeLoadDistance(detailsA);
      expect(startedUrls).to.have.lengthOf(1);

      // 标记成功后再次同 key：跳过
      (controller as any).loadStatus = 'loaded';
      (controller as any).maybeLoadDistance(detailsA);
      expect(startedUrls).to.have.lengthOf(1);

      // 切到失败，同 details 引用：仍跳过
      (controller as any).loadStatus = 'failed';
      (controller as any).lastFailedDetails = detailsA;
      (controller as any).maybeLoadDistance(detailsA);
      expect(startedUrls).to.have.lengthOf(1);

      // 失败 + 新 details 引用（同 path）：放行重试
      const detailsB = new LevelDetails('http://example.com/level.m3u8');
      detailsB.algoDistanceRelurl = 'algo_distance.ts?refreshed=1';
      (controller as any).maybeLoadDistance(detailsB);
      expect(startedUrls).to.have.lengthOf(2);
    });
  });

  describe('integration via Hls events', function () {
    it('triggers LOADING and LOADED through the full chain on success', function () {
      const triggers: Array<[string, any]> = [];
      const { hls } = createHls(triggers);
      const controller = new AlgoDistanceController(hls);
      (controller as any).started = true;

      // 用桩 loader 直接走 onSuccess 路径
      const fakeLoader: any = {
        load: (context: any, _config: any, callbacks: any) => {
          callbacks.onSuccess(
            { url: context.url, data: buildPayload() },
            {} as any,
            context,
            null,
          );
        },
        abort: () => {},
        destroy: () => {},
      };
      (controller as any).createLoader = () => fakeLoader;

      const details = new LevelDetails('http://example.com/sv/level.m3u8');
      details.algoDistanceRelurl = 'algo_distance.ts?signature=AAA';

      // 触发 LEVEL_LOADED 走完整链路（走真实的 on/off/trigger 分发）
      hls.trigger(Events.LEVEL_LOADED, { details, level: 0 });

      const eventNames = triggers.map(([name]) => name);
      expect(eventNames).to.include(Events.ALGO_DISTANCE_LOADING);
      expect(eventNames).to.include(Events.ALGO_DISTANCE_LOADED);
      expect(controller.isReady()).to.equal(true);
      expect(controller.getDistance()?.matrix).to.have.lengthOf(9);
      expect((controller as any).loadStatus).to.equal('loaded');
    });

    it('triggers ALGO_DISTANCE_ERROR with a populated payload on load error', function () {
      const triggers: Array<[string, any]> = [];
      const { hls } = createHls(triggers);
      const controller = new AlgoDistanceController(hls);
      (controller as any).started = true;
      // 跳过重试，让第一次错误直接走 markFailed + reportError
      (controller as any).retryLoad = () => false;

      const fakeLoader: any = {
        load: (context: any, _config: any, callbacks: any) => {
          callbacks.onError({ code: 404, text: 'Not Found' }, context, null, {
            /* stats */
          } as any);
        },
        abort: () => {},
        destroy: () => {},
      };
      (controller as any).createLoader = () => fakeLoader;

      const details = new LevelDetails('http://example.com/sv/level.m3u8');
      details.algoDistanceRelurl = 'algo_distance.ts';

      hls.trigger(Events.LEVEL_LOADED, { details, level: 0 });

      let errorEntry: [string, any] | undefined;
      for (let i = 0; i < triggers.length; i++) {
        if (triggers[i][0] === Events.ALGO_DISTANCE_ERROR) {
          errorEntry = triggers[i];
          break;
        }
      }
      expect(
        errorEntry,
        'should have triggered ALGO_DISTANCE_ERROR',
      ).to.not.equal(undefined);
      const [, errorPayload] = errorEntry as [string, any];
      expect(errorPayload.url).to.match(/algo_distance\.ts/);
      expect(errorPayload.error).to.be.instanceOf(Error);
      expect(errorPayload.reason).to.match(/HTTP 404/);
      // 状态机应进入 failed 终态
      expect((controller as any).loadStatus).to.equal('failed');
    });

    it('discards stale loader callbacks after MANIFEST_LOADING reset', function () {
      const triggers: Array<[string, any]> = [];
      const { hls } = createHls(triggers);
      const controller = new AlgoDistanceController(hls);
      (controller as any).started = true;

      // 桩 loader：捕获 callbacks 但延迟到外部触发；不立即调用 onSuccess
      let capturedCallbacks: any = null;
      let capturedContext: any = null;
      const fakeLoader: any = {
        load: (context: any, _config: any, callbacks: any) => {
          capturedContext = context;
          capturedCallbacks = callbacks;
        },
        abort: () => {},
        destroy: () => {},
      };
      (controller as any).createLoader = () => fakeLoader;

      const details = new LevelDetails('http://example.com/sv/level.m3u8');
      details.algoDistanceRelurl = 'algo_distance.ts';

      // 启动加载
      hls.trigger(Events.LEVEL_LOADED, { details, level: 0 });
      expect(capturedCallbacks).to.not.equal(null);

      // MANIFEST_LOADING 重置 → abortLoad 把 currentLoader 置 null
      hls.trigger(Events.MANIFEST_LOADING, {});
      expect(controller.isReady()).to.equal(false);

      // 旧回调延迟触发：世代守卫应丢弃它，不污染缓存、不再发 LOADED 事件
      const beforeLoadedCount = triggers.filter(
        ([name]) => name === Events.ALGO_DISTANCE_LOADED,
      ).length;
      capturedCallbacks.onSuccess(
        { url: capturedContext.url, data: buildPayload() },
        {} as any,
        capturedContext,
        null,
      );
      const afterLoadedCount = triggers.filter(
        ([name]) => name === Events.ALGO_DISTANCE_LOADED,
      ).length;
      expect(afterLoadedCount).to.equal(beforeLoadedCount);
      expect(controller.isReady()).to.equal(false);
    });
  });
});
