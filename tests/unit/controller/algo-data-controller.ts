import { expect } from 'chai';
import { hlsDefaultConfig } from '../../../src/config';
import AlgoDataController from '../../../src/controller/algo-data-controller';
import { Fragment } from '../../../src/loader/fragment';
import { LevelDetails } from '../../../src/loader/level-details';
import { PlaylistLevelType } from '../../../src/types/loader';
import type { MediaFragment } from '../../../src/loader/fragment';
import type { AlgoChunk, FrameItem } from '../../../src/types/algo';

describe('AlgoDataController', function () {
  describe('getFrameByTime', function () {
    function createControllerWithChunk(
      options: {
        fragStart?: number;
        fragDuration?: number;
        frameSize?: number;
        frameRate?: number;
        configFrameRate?: number;
        frameCount?: number;
      } = {},
    ) {
      const {
        fragStart = 10,
        fragDuration = 2,
        frameSize = 100,
        frameRate = 50,
        configFrameRate,
        frameCount = 100,
      } = options;
      const config = {
        ...hlsDefaultConfig,
        maxFragLookUpTolerance: 0.01,
        algoFrameRate: configFrameRate,
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
            reserved: [0, 0, 0, 0],
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

      return { controller, frames, chunk, frag };
    }

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

    it('should derive fallback frame rate from valid frame count', function () {
      const { controller, frames, frag } = createControllerWithChunk({
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

      expect(chunk.frameRate).to.equal(5);
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
  });
});
