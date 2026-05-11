import { expect } from 'chai';
import { hlsDefaultConfig } from '../../../src/config';
import AlgoDataController from '../../../src/controller/algo-data-controller';
import { Fragment } from '../../../src/loader/fragment';
import { LevelDetails } from '../../../src/loader/level-details';
import { PlaylistLevelType } from '../../../src/types/loader';
import type { MediaFragment } from '../../../src/loader/fragment';
import type { AlgoChunk, FrameItem } from '../../../src/types/algo';

describe('AlgoDataController', function () {
  // 测试公共工厂：构造单 frag 单 chunk 的 controller。
  // 提到 AlgoDataController 顶层作用域，这样 boundary fallback 块也能复用。
  function createControllerWithChunk(
    options: {
      fragStart?: number;
      fragDuration?: number;
      frameSize?: number;
      frameRate?: number;
      configFrameRate?: number;
      frameCount?: number;
      configBoundaryFallback?: boolean;
      frameTimeStep?: number;
      frameTimes?: number[];
    } = {},
  ) {
    const {
      fragStart = 10,
      fragDuration = 2,
      frameSize = 100,
      frameRate = 50,
      configFrameRate,
      frameCount = 100,
      configBoundaryFallback,
      frameTimeStep,
      frameTimes,
    } = options;
    const config = {
      ...hlsDefaultConfig,
      maxFragLookUpTolerance: 0.01,
      algoFrameRate: configFrameRate,
      algoBoundaryFallbackEnabled: configBoundaryFallback ?? false,
    };
    const warnings: string[] = [];
    const hls = {
      config,
      on: () => {},
      off: () => {},
      trigger: () => {},
      logger: { warn: (message: string) => warnings.push(message) },
    } as any;
    const controller = new AlgoDataController(hls);

    const levelDetails = new LevelDetails('http://example.com/level.m3u8');
    const frag = new Fragment(
      PlaylistLevelType.MAIN,
      'http://example.com/',
    ) as MediaFragment;
    frag.sn = 1;
    frag.start = fragStart;
    frag.duration = fragDuration;
    frag.level = 0;
    levelDetails.fragments = [frag];
    levelDetails.startSN = 1;
    levelDetails.endSN = 1;

    const frames: FrameItem[] = Array.from(
      { length: frameCount },
      (_, index) => ({
        frameIdx: 501 + index,
        autoCameras: {
          x: index,
          y: 0,
          focus: 0,
          reserved: [
            frameTimes?.[index] ??
              (frameTimeStep !== undefined ? index * frameTimeStep : 0),
            0,
            0,
            0,
          ],
        },
        tracks: [],
        detections: [],
      }),
    );
    const chunk: AlgoChunk = {
      fragSn: 1,
      algoUrl: 'http://example.com/algo/1',
      chunkIndex: 1,
      frameSize,
      frameRate:
        Number.isFinite(configFrameRate) && configFrameRate! > 0
          ? configFrameRate!
          : frameRate,
      startFrameIndex: 501,
      frames,
    };

    (controller as any).currentLevelDetails = levelDetails;
    (controller as any).algoChunkCache.set(1, chunk);

    return { controller, frames, chunk, frag, warnings };
  }

  describe('getFrameByTime', function () {
    it('should return null when time is before fragment start', function () {
      const config = {
        ...hlsDefaultConfig,
        maxFragLookUpTolerance: 0.01,
      };
      const hls = {
        config,
        on: () => {},
        off: () => {},
        trigger: () => {},
        logger: { warn: () => {} },
      } as any;
      const controller = new AlgoDataController(hls);

      const levelDetails = new LevelDetails('http://example.com/level.m3u8');
      const frag = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      frag.sn = 1;
      frag.start = 0;
      frag.duration = 1;
      frag.level = 0;
      levelDetails.fragments = [frag];
      levelDetails.startSN = 1;
      levelDetails.endSN = 1;

      const frames: FrameItem[] = Array.from({ length: 10 }, (_, index) => ({
        frameIdx: index + 1,
        autoCameras: {
          x: 0,
          y: 0,
          focus: 0,
          reserved: [0, 0, 0, 0],
        },
        tracks: [],
        detections: [],
      }));
      const chunk: AlgoChunk = {
        fragSn: 1,
        algoUrl: 'http://example.com/algo/1',
        chunkIndex: 1,
        frameSize: 10,
        frameRate: 10,
        startFrameIndex: 1,
        frames,
      };

      (controller as any).currentLevelDetails = levelDetails;
      (controller as any).algoChunkCache.set(1, chunk);

      const beforeStart = controller.getFrameByTime(-0.001);
      expect(beforeStart).to.equal(null);
      expect(controller.isDataReady(-0.001)).to.equal(false);

      const atStart = controller.getFrameByTime(0);
      expect(atStart).to.equal(frames[0]);
    });

    it('should return the first frame at fragment media start', function () {
      const { controller, frames } = createControllerWithChunk();

      const frame = controller.getFrameByTime(10);

      expect(frame).to.equal(frames[0]);
    });

    it('should use floor of local media time multiplied by frame rate', function () {
      const { controller, frames } = createControllerWithChunk();

      const frame = controller.getFrameByTime(10.75);

      expect(frame).to.equal(frames[37]);
    });

    it('should prefer frameTime in autoCameras.reserved[0] when available', function () {
      // frameTimeStep 单位为 ms（reserved[0] 协议）；输出 frameTime 仍是秒。
      const { controller, frames } = createControllerWithChunk({
        frameRate: 25,
        frameTimeStep: 20,
      });

      const context = controller.getFrameContextByTime(10.75);

      expect(context?.frame).to.equal(frames[37]);
      expect(context?.localFrameIndex).to.equal(37);
      expect(context?.frameTime).to.be.closeTo(0.74, 0.000001);
    });

    it('should fall back to frameRate when frameTime values are not strictly increasing', function () {
      const { controller, frames } = createControllerWithChunk({
        frameTimeStep: 20,
        frameTimes: [0, 20, 10],
      });

      const context = controller.getFrameContextByTime(10.06);

      expect(context?.frame).to.equal(frames[3]);
      expect(context?.localFrameIndex).to.equal(3);
      expect(context?.frameTime).to.equal(undefined);
    });

    it('should fall back to frameRate when frameTime does not start near zero', function () {
      const { controller, frames } = createControllerWithChunk({
        frameTimeStep: 20,
        frameTimes: [500, 520, 540],
      });

      const context = controller.getFrameContextByTime(10.06);

      expect(context?.frame).to.equal(frames[3]);
      expect(context?.localFrameIndex).to.equal(3);
      expect(context?.frameTime).to.equal(undefined);
    });

    it('should fall back to frameRate for single-frame all-zero legacy data', function () {
      const { controller, frames } = createControllerWithChunk({
        frameCount: 1,
        frameSize: 1,
        frameTimeStep: 0,
      });

      const context = controller.getFrameContextByTime(10);

      expect(context?.frame).to.equal(frames[0]);
      expect(context?.localFrameIndex).to.equal(0);
      expect(context?.frameTime).to.equal(undefined);
    });

    it('should keep the last frame inside its frameTime duration without fallback', function () {
      const { controller, frames } = createControllerWithChunk({
        frameTimeStep: 20,
      });

      const context = controller.getFrameContextByTime(11.99);

      expect(context?.frame).to.equal(frames[99]);
      expect(context?.localFrameIndex).to.equal(99);
      expect(context?.frameTime).to.be.closeTo(1.98, 0.000001);
      expect(context?.fallback).to.equal(undefined);
    });

    it('should keep the last frame available near fragment end', function () {
      const { controller, frames } = createControllerWithChunk();

      const frame = controller.getFrameByTime(11.99);

      expect(frame).to.equal(frames[99]);
    });

    it('should expose frame context with local frame index', function () {
      const { controller, frames, chunk, frag } = createControllerWithChunk();

      const context = controller.getFrameContextByTime(10.02);

      expect(context?.frame).to.equal(frames[1]);
      expect(context?.chunk).to.equal(chunk);
      expect(context?.frag).to.equal(frag);
      expect(context?.fragSn).to.equal(1);
      expect(context?.chunkIndex).to.equal(1);
      expect(context?.localFrameIndex).to.equal(1);
      expect(context?.frameRate).to.equal(50);
      expect(context?.frameSize).to.equal(100);
      expect(context?.mediaTime).to.equal(10.02);
      expect(context?.localTime).to.be.closeTo(0.02, 0.000001);
      expect(context?.frameTime).to.equal(undefined);
    });

    it('should return null when local frame index exceeds frameSize', function () {
      const { controller } = createControllerWithChunk({
        frameSize: 10,
        frameCount: 100,
      });

      const frame = controller.getFrameByTime(10.2);

      expect(frame).to.equal(null);
    });

    it('should fall back to frames length when frameSize is invalid', function () {
      const { controller, frames } = createControllerWithChunk({
        frameSize: 0,
        frameCount: 5,
      });

      const lastFrame = controller.getFrameByTime(10.08);
      const outOfRangeFrame = controller.getFrameByTime(10.1);

      expect(lastFrame).to.equal(frames[4]);
      expect(outOfRangeFrame).to.equal(null);
    });

    it('should not derive fallback frame rate from frag duration', function () {
      const { controller, frames, frag, warnings } = createControllerWithChunk({
        fragDuration: 2,
        frameSize: 10,
        frameCount: 100,
      });

      const chunk = (controller as any).buildAlgoChunk(frag, 'algo-url', {
        version: 1,
        chunkIndex: 1,
        frameSize: 10,
        frames,
      });

      expect(chunk.frameRate).to.equal(0);
      expect(
        warnings.some((message) =>
          message.includes('Missing algo frameRate source'),
        ),
      ).to.equal(true);
    });

    it('should warn when config frameRate overrides message frameRate', function () {
      const { controller, frames, frag, warnings } = createControllerWithChunk({
        configFrameRate: 50,
      });

      const chunk = (controller as any).buildAlgoChunk(frag, 'algo-url', {
        version: 1,
        chunkIndex: 1,
        frameSize: 10,
        frameRate: 25,
        frames,
      });

      expect(chunk.frameRate).to.equal(50);
      expect(
        warnings.some((message) =>
          message.includes('algoFrameRate=50 overrides message.frameRate=25'),
        ),
      ).to.equal(true);
    });

    it('should not treat root-level Uint8Array as the frames array in 5-value payloads', function () {
      const { controller, frames } = createControllerWithChunk();
      const root = (controller as any).extractRootFields([
        1,
        2,
        3,
        new Uint8Array([1, 2, 3]),
        frames,
      ]);

      expect(root.framesRaw).to.equal(frames);
    });

    it('should preserve raw reserved[0] when parsing flat-array autoCamera', function () {
      // parseAutoCamera 不做单位换算，保留协议层面的整数 ms 原值。
      const { controller } = createControllerWithChunk();

      const autoCamera = (controller as any).parseAutoCamera([
        1, 2, 3, 20, 0, 0, 0,
      ]);

      expect(autoCamera.reserved[0]).to.equal(20);
    });
  });

  describe('boundary fallback', function () {
    // 复现 zuqiu m3u8 的 PTS 缝隙：两个视频片之间有一段 currentTime 既不在前片
    // 也不在后片范围内（hls.js 内部 frag.duration 被算法旁路片污染所致）。
    // prev 真实视频帧只到 10.0s，next.start=10.628s，缝隙 10.0~10.628s。
    function createControllerWithTwoFragments(
      options: {
        fallbackEnabled?: boolean;
        cachePrev?: boolean;
        cacheNext?: boolean;
        prevDuration?: number;
        frameTimeStep?: number;
      } = {},
    ) {
      const {
        fallbackEnabled = false,
        cachePrev = true,
        cacheNext = true,
        prevDuration = 10.0,
        frameTimeStep,
      } = options;
      const config = {
        ...hlsDefaultConfig,
        maxFragLookUpTolerance: 0.01,
        algoBoundaryFallbackEnabled: fallbackEnabled,
      };
      const hls = {
        config,
        on: () => {},
        off: () => {},
        trigger: () => {},
        logger: { warn: () => {} },
      } as any;
      const controller = new AlgoDataController(hls);

      const levelDetails = new LevelDetails('http://example.com/level.m3u8');
      const prevFrag = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      prevFrag.sn = 1;
      prevFrag.start = 0;
      prevFrag.duration = prevDuration; // 真实视频帧覆盖 0~10.0s；测试可放大模拟"被拉长"
      prevFrag.level = 0;

      const nextFrag = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      nextFrag.sn = 2;
      nextFrag.start = 10.628; // 与 prev 之间留 0.628s PTS 缝隙
      nextFrag.duration = 10.0;
      nextFrag.level = 0;

      levelDetails.fragments = [prevFrag, nextFrag];
      levelDetails.startSN = 1;
      levelDetails.endSN = 2;

      const makeFrames = (start: number, count: number): FrameItem[] =>
        Array.from({ length: count }, (_, index) => ({
          frameIdx: start + index,
          autoCameras: {
            x: index,
            y: 0,
            focus: 0,
            reserved: [
              frameTimeStep !== undefined ? index * frameTimeStep : 0,
              0,
              0,
              0,
            ],
          },
          tracks: [],
          detections: [],
        }));

      const prevFrames = makeFrames(1, 500);
      const prevChunk: AlgoChunk = {
        fragSn: 1,
        algoUrl: 'http://example.com/algo/1',
        chunkIndex: 1,
        frameSize: 500,
        frameRate: 50,
        startFrameIndex: 1,
        frames: prevFrames,
      };
      const nextFrames = makeFrames(501, 500);
      const nextChunk: AlgoChunk = {
        fragSn: 2,
        algoUrl: 'http://example.com/algo/2',
        chunkIndex: 2,
        frameSize: 500,
        frameRate: 50,
        startFrameIndex: 501,
        frames: nextFrames,
      };

      (controller as any).currentLevelDetails = levelDetails;
      if (cachePrev) (controller as any).algoChunkCache.set(1, prevChunk);
      if (cacheNext) (controller as any).algoChunkCache.set(2, nextChunk);

      return {
        controller,
        prevFrag,
        nextFrag,
        prevChunk,
        nextChunk,
        prevFrames,
        nextFrames,
      };
    }

    it('returns null in PTS gap when fallback is disabled (default)', function () {
      const { controller } = createControllerWithTwoFragments({
        fallbackEnabled: false,
      });
      // time=10.38 落在 prev.end(10.0) 与 next.start(10.628) 之间
      // findFragmentByTime 配 tolerance=0.01 在两片都 miss，返回 null → 主路径直接 null
      expect(controller.getFrameByTime(10.38)).to.equal(null);
      expect(controller.getFrameContextByTime(10.38)).to.equal(null);
    });

    it('clamps to prev fragment last frame in PTS gap when fallback is enabled', function () {
      const { controller, prevFrames, prevFrag } =
        createControllerWithTwoFragments({ fallbackEnabled: true });

      const context = controller.getFrameContextByTime(10.38);

      expect(context).to.not.equal(null);
      expect(context?.frame).to.equal(prevFrames[499]); // clamp 到 vfc-1
      expect(context?.localFrameIndex).to.equal(499);
      expect(context?.fallback).to.equal(true);
      expect(context?.frag).to.equal(prevFrag);
      expect(context?.fragSn).to.equal(1);
    });

    it('uses normal path (no fallback flag) when time is inside next fragment', function () {
      const { controller, nextFrames } = createControllerWithTwoFragments({
        fallbackEnabled: true,
      });

      // time=10.7 落在 next.start(10.628) 之后，正常命中 next
      // localTime = 10.7 - 10.628 = 0.072, idx = floor(0.072 * 50 + 1e-6) = 3
      const context = controller.getFrameContextByTime(10.7);

      expect(context).to.not.equal(null);
      expect(context?.frame).to.equal(nextFrames[3]);
      expect(context?.localFrameIndex).to.equal(3);
      expect(context?.fragSn).to.equal(2);
      expect(context?.fallback).to.equal(undefined);
    });

    it('returns null when fallback is enabled but prev chunk is not cached', function () {
      // 模拟 prev 的 algo chunk 已被 LRU 淘汰，只剩 next。fallback 找到 prevFrag
      // 但 getChunkByFragment(prevFrag) 返回 null，不向更前扩散 → 直接 null。
      const { controller } = createControllerWithTwoFragments({
        fallbackEnabled: true,
        cachePrev: false,
        cacheNext: true,
      });

      expect(controller.getFrameByTime(10.38)).to.equal(null);
      expect(controller.getFrameContextByTime(10.38)).to.equal(null);
    });

    it('returns null when fallback is enabled but time is before first fragment', function () {
      // time<firstFrag.start，findFallbackFragForTime 找不到任何 start<=time 的片
      const { controller } = createControllerWithTwoFragments({
        fallbackEnabled: true,
      });

      expect(controller.getFrameByTime(-0.01)).to.equal(null);
    });

    it('clamps to last frame when prev frag.duration is inflated and main path idx overflows', function () {
      // 复现真实业务场景：hls.js 通过 updateFromToPTS 把 prev.duration 拉长到 10.6287
      // (实测 zuqiu0)，findFragmentByTime eager match 在 time=10.20 仍返回 prev（因为
      // prev.start+prev.duration=10.6287 > 10.20）。这种情况 time >= frag.start，
      // 不会进入 "time<frag.start" 的前片 fallback 分支；但主路径 idx 越界
      // (10.20*50=510 >= vfc=500)，需要"主路径 idx 越界 clamp"分支兜住。
      const { controller, prevFrames, prevFrag } =
        createControllerWithTwoFragments({
          fallbackEnabled: true,
          prevDuration: 10.6287,
        });

      const context = controller.getFrameContextByTime(10.2);

      expect(context).to.not.equal(null);
      expect(context?.frame).to.equal(prevFrames[499]);
      expect(context?.localFrameIndex).to.equal(499);
      expect(context?.fallback).to.equal(true);
      expect(context?.frag).to.equal(prevFrag);
      expect(context?.fragSn).to.equal(1);
    });

    it('clamps by last frameTime when prev frag.duration is inflated', function () {
      // 新算法数据在 autoCameras.reserved[0] 携带分片内 frameTime（整数 ms）。即使
      // frag.duration 被 hls.js 拉长，frameTime 仍能指出真实算法帧覆盖到 9.98s；
      // time=10.2 应沿用末帧。
      const { controller, prevFrames, prevFrag } =
        createControllerWithTwoFragments({
          fallbackEnabled: true,
          prevDuration: 10.6287,
          frameTimeStep: 20,
        });

      const context = controller.getFrameContextByTime(10.2);

      expect(context).to.not.equal(null);
      expect(context?.frame).to.equal(prevFrames[499]);
      expect(context?.localFrameIndex).to.equal(499);
      expect(context?.frameTime).to.be.closeTo(9.98, 0.000001);
      expect(context?.fallback).to.equal(true);
      expect(context?.frag).to.equal(prevFrag);
      expect(context?.fragSn).to.equal(1);
    });

    it('returns null on frameTime tail overflow when fallback is disabled', function () {
      const { controller } = createControllerWithTwoFragments({
        fallbackEnabled: false,
        prevDuration: 10.6287,
        frameTimeStep: 20,
      });

      expect(controller.getFrameByTime(10.2)).to.equal(null);
      expect(controller.getFrameContextByTime(10.2)).to.equal(null);
    });

    it('clamps to frameSize-1 (not frames.length-1) on partial tail when fallback is enabled', function () {
      // partial 尾片：服务端只下发 200 帧 algo（frameSize=200），但 chunk.frames
      // 数组容量为 500（hls.js 缓存预分配/复用）。validFrameCount = min(200, 500) = 200。
      // time=4.5s 已超过 algo 真实覆盖区间(200/50=4.0s)，idx=225 越界，应 clamp 到
      // frames[199]——不是 frames[499]——以保证返回的是真实算法数据末帧。
      const { controller, frames } = createControllerWithChunk({
        fragStart: 0,
        fragDuration: 10.6287,
        frameSize: 200,
        frameCount: 500,
        configBoundaryFallback: true,
        frameTimeStep: 20,
      });
      frames[250].autoCameras.reserved[0] = NaN;

      const context = controller.getFrameContextByTime(4.5);

      expect(context).to.not.equal(null);
      expect(context?.frame).to.equal(frames[199]);
      expect(context?.localFrameIndex).to.equal(199);
      expect(context?.frameSize).to.equal(200);
      expect(context?.frameTime).to.be.closeTo(3.98, 0.000001);
      expect(context?.fallback).to.equal(true);
    });

    it('skips short bypass-style fragments (no chunk) when searching for fallback prev', function () {
      // fragments=[prevVideo, fakeNoChunk(EXTINF=0.001 旁路片), nextVideo]
      // time=10.2 落在 fakeNoChunk 末尾(10.001)与 nextVideo.start(10.628)之间的 PTS 缝隙。
      // 从右向左扫先撞到 fakeNoChunk(start=10.0<=10.2)：无 chunk + duration=0.001 ≤ 0.1
      // 阈值 → 识别为算法旁路伪片，跳过；继续找到 prevVideo 有 chunk → 返回 + clamp 末帧。
      // 区别于"真实视频片 chunk 缺失"场景（见下一用例），那种情况会立即 return null。
      const config = {
        ...hlsDefaultConfig,
        maxFragLookUpTolerance: 0.01,
        algoBoundaryFallbackEnabled: true,
      };
      const hls = {
        config,
        on: () => {},
        off: () => {},
        trigger: () => {},
        logger: { warn: () => {} },
      } as any;
      const controller = new AlgoDataController(hls);

      const levelDetails = new LevelDetails('http://example.com/level.m3u8');

      const prevVideo = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      prevVideo.sn = 1;
      prevVideo.start = 0;
      prevVideo.duration = 10.0;
      prevVideo.level = 0;

      const fakeNoChunk = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      fakeNoChunk.sn = 2;
      fakeNoChunk.start = 10.0;
      fakeNoChunk.duration = 0.001;
      fakeNoChunk.level = 0;

      const nextVideo = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      nextVideo.sn = 3;
      nextVideo.start = 10.628;
      nextVideo.duration = 10.0;
      nextVideo.level = 0;

      levelDetails.fragments = [prevVideo, fakeNoChunk, nextVideo];
      levelDetails.startSN = 1;
      levelDetails.endSN = 3;

      const prevFrames: FrameItem[] = Array.from(
        { length: 500 },
        (_, index) => ({
          frameIdx: index + 1,
          autoCameras: { x: index, y: 0, focus: 0, reserved: [0, 0, 0, 0] },
          tracks: [],
          detections: [],
        }),
      );
      const prevChunk: AlgoChunk = {
        fragSn: 1,
        algoUrl: 'http://example.com/algo/1',
        chunkIndex: 1,
        frameSize: 500,
        frameRate: 50,
        startFrameIndex: 1,
        frames: prevFrames,
      };

      (controller as any).currentLevelDetails = levelDetails;
      (controller as any).algoChunkCache.set(1, prevChunk);
      // fakeNoChunk(sn=2) 与 nextVideo(sn=3) 都不放入 algoChunkCache

      // time=10.2 在 fakeNoChunk 末尾(10.001)与 nextVideo.start(10.628)之间的缝隙；
      // 从右往左扫，先撞到 fakeNoChunk(start=10.0<=10.2)，但它无 chunk 且 duration=0.001
      // ≤ 0.1s 阈值 → 识别为伪片跳过，继续找到 prevVideo 有 chunk → 返回 + clamp 末帧
      const context = controller.getFrameContextByTime(10.2);

      expect(context).to.not.equal(null);
      expect(context?.frame).to.equal(prevFrames[499]);
      expect(context?.localFrameIndex).to.equal(499);
      expect(context?.fallback).to.equal(true);
      expect(context?.frag).to.equal(prevVideo);
      expect(context?.fragSn).to.equal(1);
    });

    it('returns null instead of extending across a real video frag with chunk missing', function () {
      // 关键安全用例（与上一用例对照）：fragments=[sn1 有 chunk, sn2 真实视频片但 chunk
      // 缺失（LRU 淘汰/加载失败），sn3 next（带间隙）]，time 落在 sn2 末尾与 sn3.start
      // 之间的缝隙。
      //
      // 期望：返回 null，**不能扩散到 sn1 末帧**——因为 sn2 是真实视频片
      // (duration=10s 远超 0.1s 阈值)，它的 chunk 缺失意味着"当前应该播这片但 algo 没了"，
      // 此时把 sn1（10 秒前的内容）的算法数据顶到当前画面是更隐蔽的语义错误（比黑窗更糟）。
      //
      // 这个用例锁住"fallback 不跨真实视频片扩散"这个保守策略，与上一用例（跳过算法旁路
      // 伪片）形成行为对照。
      const config = {
        ...hlsDefaultConfig,
        maxFragLookUpTolerance: 0.01,
        algoBoundaryFallbackEnabled: true,
      };
      const hls = {
        config,
        on: () => {},
        off: () => {},
        trigger: () => {},
        logger: { warn: () => {} },
      } as any;
      const controller = new AlgoDataController(hls);

      const levelDetails = new LevelDetails('http://example.com/level.m3u8');

      const sn1 = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      sn1.sn = 1;
      sn1.start = 0;
      sn1.duration = 10.0;
      sn1.level = 0;

      const sn2RealVideoNoChunk = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      sn2RealVideoNoChunk.sn = 2;
      sn2RealVideoNoChunk.start = 10.0;
      sn2RealVideoNoChunk.duration = 10.0; // 真实视频片，远超 0.1s 阈值
      sn2RealVideoNoChunk.level = 0;

      const sn3 = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      sn3.sn = 3;
      sn3.start = 20.5; // 与 sn2 之间留 0.5s 缝隙模拟 PTS gap
      sn3.duration = 10.0;
      sn3.level = 0;

      levelDetails.fragments = [sn1, sn2RealVideoNoChunk, sn3];
      levelDetails.startSN = 1;
      levelDetails.endSN = 3;

      const sn1Frames: FrameItem[] = Array.from(
        { length: 500 },
        (_, index) => ({
          frameIdx: index + 1,
          autoCameras: { x: index, y: 0, focus: 0, reserved: [0, 0, 0, 0] },
          tracks: [],
          detections: [],
        }),
      );
      const sn1Chunk: AlgoChunk = {
        fragSn: 1,
        algoUrl: 'http://example.com/algo/1',
        chunkIndex: 1,
        frameSize: 500,
        frameRate: 50,
        startFrameIndex: 1,
        frames: sn1Frames,
      };

      (controller as any).currentLevelDetails = levelDetails;
      (controller as any).algoChunkCache.set(1, sn1Chunk);
      // sn2 的 chunk 故意不放入 cache —— 模拟 LRU 淘汰

      // time=20.3 落在 sn2 末尾(20.0)与 sn3.start(20.5)之间
      // findFallbackFragForTime 从右向左：sn3(start=20.5) 跳过；sn2(start=10) 命中
      // 但无 chunk 且 duration=10>0.1 → 立即 return null，不扩散到 sn1
      expect(controller.getFrameByTime(20.3)).to.equal(null);
      expect(controller.getFrameContextByTime(20.3)).to.equal(null);
    });

    it('returns null when no-chunk candidate has anomalous duration (zero)', function () {
      // 防御性回归：阈值判定必须是"有限正数且 ≤ 0.1s"才放行，duration 是 0 / 负数 /
      // NaN / Infinity 这些异常值一律视为"不像伪片"返回 null，不向更前扩散。
      // 防止以后写成单纯 `duration > 0.1` → 0/NaN 被误判成短伪片继续往前找，把更旧的
      // 算法数据顶到当前画面上。原则："宁可黑窗，不跨真实片错配"。
      //
      // 用 duration=0 而非 NaN：duration=0 时 findFragmentByPTS 返回 null（tolerance
      // 计算正常)，能进入 fallback 路径并真正命中 findFallbackFragForTime 的 duration
      // 判定。NaN 会让 fragment-finders 的 NaN 比较默认返回 match，绕开 fallback 路径。
      const config = {
        ...hlsDefaultConfig,
        maxFragLookUpTolerance: 0.01,
        algoBoundaryFallbackEnabled: true,
      };
      const hls = {
        config,
        on: () => {},
        off: () => {},
        trigger: () => {},
        logger: { warn: () => {} },
      } as any;
      const controller = new AlgoDataController(hls);

      const levelDetails = new LevelDetails('http://example.com/level.m3u8');

      const sn1 = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      sn1.sn = 1;
      sn1.start = 0;
      sn1.duration = 10.0;
      sn1.level = 0;

      const sn2Anomalous = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      sn2Anomalous.sn = 2;
      sn2Anomalous.start = 10.0;
      sn2Anomalous.duration = 0; // 异常 duration（模拟 0 / 负数 / Infinity 等异常值的处理）
      sn2Anomalous.level = 0;

      const sn3 = new Fragment(
        PlaylistLevelType.MAIN,
        'http://example.com/',
      ) as MediaFragment;
      sn3.sn = 3;
      sn3.start = 10.5;
      sn3.duration = 10.0;
      sn3.level = 0;

      levelDetails.fragments = [sn1, sn2Anomalous, sn3];
      levelDetails.startSN = 1;
      levelDetails.endSN = 3;

      const sn1Frames: FrameItem[] = Array.from(
        { length: 500 },
        (_, index) => ({
          frameIdx: index + 1,
          autoCameras: { x: index, y: 0, focus: 0, reserved: [0, 0, 0, 0] },
          tracks: [],
          detections: [],
        }),
      );
      const sn1Chunk: AlgoChunk = {
        fragSn: 1,
        algoUrl: 'http://example.com/algo/1',
        chunkIndex: 1,
        frameSize: 500,
        frameRate: 50,
        startFrameIndex: 1,
        frames: sn1Frames,
      };

      (controller as any).currentLevelDetails = levelDetails;
      (controller as any).algoChunkCache.set(1, sn1Chunk);

      // time=10.2 落在 sn2 末尾(10.0)与 sn3.start(10.5)之间；findFragmentByPTS
      // 返回 null → 进入 fallback。findFallbackFragForTime 从右扫到 sn2(start=10<=10.2)
      // 命中：无 chunk + duration=0 → `Number.isFinite(0) && 0 > 0` 短路为 false →
      // isShortBypass=false → return null，不扩散到 sn1
      expect(controller.getFrameByTime(10.2)).to.equal(null);
      expect(controller.getFrameContextByTime(10.2)).to.equal(null);
    });
  });
});
