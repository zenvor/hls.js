import { encode } from '@msgpack/msgpack';
import { expect } from 'chai';
import { hlsDefaultConfig } from '../../../src/config';
import AlgoDistanceController from '../../../src/controller/algo-distance-controller';
import { LevelDetails } from '../../../src/loader/level-details';
import type { AlgoDistanceData } from '../../../src/types/algo';

describe('AlgoDistanceController', function () {
  function createController(triggerCalls?: Array<[string, any]>) {
    const config = {
      ...hlsDefaultConfig,
    };
    const hls = {
      config,
      on: () => {},
      off: () => {},
      trigger: (event: string, data: any) => {
        triggerCalls?.push([event, data]);
      },
      logger: { warn: () => {} },
    } as any;
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
      expect(result.matrix).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(result.raw).to.have.lengthOf(5);
      expect(result.raw[0]).to.equal(1);
      expect(result.raw[1]).to.equal(false);
      expect(result.raw[2]).to.equal(true);
    });

    it('throws when root is not fixarray(5)', function () {
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
      (controller as any).currentDistanceKey = 'foo';
      (controller as any).retryCount = 3;

      (controller as any).onManifestLoading();

      expect(controller.getDistance()).to.equal(null);
      expect((controller as any).currentDistanceKey).to.equal(null);
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

    it('dedupes loads with the same path even when query string changes', function () {
      const triggers: Array<[string, any]> = [];
      const controller = createController(triggers);
      (controller as any).started = true;

      // Stub startDistanceLoad to avoid creating a real loader
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
      };

      const detailsA = new LevelDetails('http://example.com/level.m3u8');
      detailsA.algoDistanceRelurl = 'sub/algo_distance.ts?signature=AAA';
      (controller as any).maybeLoadDistance(detailsA);

      const detailsB = new LevelDetails('http://example.com/level.m3u8');
      detailsB.algoDistanceRelurl = 'sub/algo_distance.ts?signature=BBB';
      (controller as any).maybeLoadDistance(detailsB);

      expect(startedUrls).to.have.lengthOf(1);
      expect((controller as any).currentDistanceKey).to.equal(
        'sub/algo_distance.ts',
      );
    });

    it('starts a new load when the path key changes', function () {
      const controller = createController();
      (controller as any).started = true;
      const startedUrls: string[] = [];
      (controller as any).startDistanceLoad = (url: string) => {
        startedUrls.push(url);
      };

      const detailsA = new LevelDetails('http://example.com/a/level.m3u8');
      detailsA.algoDistanceRelurl = 'algo_distance.ts';
      (controller as any).maybeLoadDistance(detailsA);

      const detailsB = new LevelDetails('http://example.com/b/level.m3u8');
      detailsB.algoDistanceRelurl = 'other_distance.ts';
      (controller as any).maybeLoadDistance(detailsB);

      expect(startedUrls).to.have.lengthOf(2);
      expect((controller as any).currentDistanceKey).to.equal(
        'other_distance.ts',
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
  });
});
