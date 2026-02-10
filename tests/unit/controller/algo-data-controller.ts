import chai from 'chai';
import { hlsDefaultConfig } from '../../../src/config';
import AlgoDataController from '../../../src/controller/algo-data-controller';
import { Fragment } from '../../../src/loader/fragment';
import { LevelDetails } from '../../../src/loader/level-details';
import { PlaylistLevelType } from '../../../src/types/loader';
import type { MediaFragment } from '../../../src/loader/fragment';
import type { AlgoChunk, FrameItem } from '../../../src/types/algo';

const expect = chai.expect;

describe('AlgoDataController', function () {
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
  });
});
