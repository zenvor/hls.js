import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { hlsDefaultConfig } from '../../src/config';
import { ErrorDetails, ErrorTypes } from '../../src/errors';
import { Events } from '../../src/events';
import Hls from '../../src/hls';

use(sinonChai);

describe('Hls', function () {
  describe('bandwidthEstimate', function () {
    it('should return a bandwidth estimate', function () {
      const MOCKED_ESTIMATE = 2000;
      const hls = new Hls();
      (hls as any).abrController = {
        bwEstimator: {
          getEstimate: () => MOCKED_ESTIMATE,
        },
      };
      expect(hls.bandwidthEstimate).to.equal(MOCKED_ESTIMATE);
    });

    it('should return a default bandwidth estimate', function () {
      const hls = new Hls();
      expect(hls.bandwidthEstimate).to.equal(
        hlsDefaultConfig.abrEwmaDefaultEstimate,
      );
    });
  });

  describe('attachMedia and detachMedia', function () {
    function detachTest(hls: Hls, media: HTMLMediaElement, refCount: number) {
      const components = (hls as any).coreComponents
        .concat((hls as any).networkControllers)
        .reduce((withMedia, component) => {
          if ('media' in component) {
            if (component.media === media) {
              withMedia.push(component);
            }
          }
          return withMedia;
        }, []);
      hls.detachMedia();
      expect(hls.media).to.equal(null, 'Hls');
      expect(components).to.have.lengthOf(refCount);
      components.forEach((component) => {
        expect(component.media || null).to.equal(
          null,
          component.constructor?.name,
        );
      });
    }

    it('should add and remove references to the "media" element immediately', function () {
      const hls = new Hls({ capLevelOnFPSDrop: true });
      expect(hls.media).to.equal(null);
      const media = document.createElement('video');
      expect(media).to.be.an('HTMLVideoElement');
      hls.attachMedia(media);
      expect(hls.media).to.equal(media);
      detachTest(hls, media, 6);
      hls.destroy();
    });

    it('should add and remove references to the "media" element after attached', function () {
      const hls = new Hls({
        capLevelOnFPSDrop: true,
        emeEnabled: true,
        cmcd: {},
      });
      expect(hls.media).to.equal(null);
      const media = document.createElement('video');
      expect(media).to.be.an('HTMLVideoElement');
      hls.attachMedia(media);
      expect(hls.media).to.equal(media);
      hls.trigger(Events.MEDIA_ATTACHED, { media });
      detachTest(hls, media, 14);
      hls.destroy();
    });

    it('should trigger an error event when attachMedia is called with null', function () {
      const hls = new Hls();
      const triggerSpy = sinon.spy(hls, 'trigger');

      hls.on(Events.ERROR, function (_event, _data) {});
      (hls as any).attachMedia(null);

      const expectedEvent = {
        type: ErrorTypes.OTHER_ERROR,
        details: ErrorDetails.ATTACH_MEDIA_ERROR,
        fatal: true,
        error: sinon.match
          .instanceOf(Error)
          .and(
            sinon.match.has(
              'message',
              'attachMedia failed: invalid argument (null)',
            ),
          ),
      };

      expect(triggerSpy).to.be.calledWith(
        Events.ERROR,
        sinon.match(expectedEvent),
      );

      triggerSpy.restore();
      hls.destroy();
    });
  });

  describe('loadSource and url', function () {
    it('url should initially be null', function () {
      const hls = new Hls();
      expect(hls.url).to.equal(null);
      hls.destroy();
    });

    it('should return given url after load', function () {
      const hls = new Hls();
      hls.loadSource(
        'https://video-dev.github.io/streams/x36xhzz/x36xhzz.m3u8',
      );
      expect(hls.url).to.equal(
        'https://video-dev.github.io/streams/x36xhzz/x36xhzz.m3u8',
      );
      hls.destroy();
    });

    it('should make relative url absolute', function () {
      const hls = new Hls();
      hls.loadSource('/streams/x36xhzz/x36xhzz.m3u8');
      expect(hls.url).to.equal(
        `${self.location.origin}/streams/x36xhzz/x36xhzz.m3u8`,
      );
      hls.destroy();
    });
  });

  describe('destroy', function () {
    it('should not crash on stopLoad() after destroy()', function () {
      const hls = new Hls();
      hls.destroy();
      expect(() => hls.stopLoad()).to.not.throw();
    });

    it('should not crash on startLoad() after destroy()', function () {
      const hls = new Hls();
      hls.destroy();
      expect(() => hls.startLoad()).to.not.throw();
    });

    it('has no circular references after calling destroy()', function () {
      const hls = new Hls();
      hls.destroy();
      expect(() => JSON.stringify(hls)).to.not.throw();
    });
  });

  describe('nextAudioTrack', function () {
    it('should return -1 when audioStreamController is not available', function () {
      const hls = new Hls();
      (hls as any).audioStreamController = null;
      expect(hls.nextAudioTrack).to.equal(-1);
      hls.destroy();
    });

    it('should not crash when audioTrackController is not available', function () {
      const hls = new Hls();
      (hls as any).audioTrackController = null;

      expect(() => {
        hls.nextAudioTrack = 2;
      }).to.not.throw();

      hls.destroy();
    });

    it('should set nextAudioTrack on audioTrackController', function () {
      const hls = new Hls();
      const mockAudioTrackController = {
        nextAudioTrack: 0,
      };
      (hls as any).audioTrackController = mockAudioTrackController;

      hls.nextAudioTrack = 2;

      expect(mockAudioTrackController.nextAudioTrack).to.equal(2);
      hls.destroy();
    });

    it('should return -1 when audioStreamController is undefined', function () {
      const hls = new Hls();
      (hls as any).audioStreamController = undefined;
      expect(hls.nextAudioTrack).to.equal(-1);
      hls.destroy();
    });
  });

  describe('recoverMediaErrorBySkippingFrag', function () {
    it('skips to the end of the current fragment and resumes loading after re-attach', function () {
      const hls = new Hls();
      const media = document.createElement('video');
      media.currentTime = 357.1;
      (hls as any)._media = media;
      (hls as any).started = true;
      (hls as any).streamController = {
        getLevelDetails: () => ({
          fragments: [
            { sn: 34, start: 340, duration: 10 },
            { sn: 35, start: 350, duration: 10, end: 360 },
            { sn: 36, start: 360, duration: 10 },
          ],
        }),
        getMainFwdBufferInfo: () => null,
      };

      const detachSpy = sinon.stub(hls, 'detachMedia');
      const attachSpy = sinon.stub(hls, 'attachMedia');
      const startLoadSpy = sinon.stub(hls, 'startLoad');

      const result = hls.recoverMediaErrorBySkippingFrag();

      // brokenFrameSkipSize 默认 1.0s，所以 targetTime = 357.1 + 1.0 = 358.1
      expect(result).to.deep.equal({
        ok: true,
        targetTime: 358.1,
        fragSn: 35,
        fragStart: 350,
        fragEnd: 360,
      });
      expect(detachSpy).to.have.been.calledOnce;
      expect(attachSpy).to.have.been.calledOnceWith(media);

      hls.trigger(Events.MEDIA_ATTACHED, { media });

      expect(media.currentTime).to.equal(358.1);
      expect(startLoadSpy).to.have.been.calledOnceWith(358.1, true);

      hls.destroy();
    });

    it('falls back to the next buffered start when current time is not inside a fragment', function () {
      const hls = new Hls();
      const media = document.createElement('video');
      media.currentTime = 357.1;
      (hls as any)._media = media;
      (hls as any).streamController = {
        getLevelDetails: () => ({
          fragments: [
            { sn: 1, start: 0, duration: 10 },
            { sn: 2, start: 10, duration: 10 },
          ],
        }),
        getMainFwdBufferInfo: () => ({
          nextStart: 370,
        }),
      };

      sinon.stub(hls, 'detachMedia');
      sinon.stub(hls, 'attachMedia');

      const result = hls.recoverMediaErrorBySkippingFrag();

      expect(result).to.deep.equal({
        ok: true,
        targetTime: 370.001,
      });

      hls.destroy();
    });

    it('does not retry the same fragment within the cooldown window', function () {
      const hls = new Hls();
      const media = document.createElement('video');
      media.currentTime = 357.1;
      (hls as any)._media = media;
      (hls as any).streamController = {
        getLevelDetails: () => ({
          fragments: [{ sn: 35, start: 350, duration: 10, end: 360 }],
        }),
        getMainFwdBufferInfo: () => null,
      };
      // 模拟上次跳过的位置接近当前位置（差值 < brokenFragmentSkipOffset 0.001）
      (hls as any).lastSkippedBrokenFromTime = 357.1;
      (hls as any).lastSkippedBrokenFragAt = 1000;
      const nowStub = sinon.stub(self.performance, 'now').returns(1200);

      const result = hls.recoverMediaErrorBySkippingFrag();

      expect(result).to.deep.equal({
        ok: false,
        reason: 'no safe fragment skip target available',
      });

      nowStub.restore();
      hls.destroy();
    });

    it('returns ok: false when media is not attached', function () {
      const hls = new Hls();
      (hls as any)._media = null;

      const result = hls.recoverMediaErrorBySkippingFrag();

      expect(result).to.deep.equal({
        ok: false,
        reason: 'media is not attached',
      });

      hls.destroy();
    });

    it('returns ok: false when media currentTime is NaN', function () {
      const hls = new Hls();
      const media = document.createElement('video');
      Object.defineProperty(media, 'currentTime', {
        configurable: true,
        value: NaN,
      });
      (hls as any)._media = media;

      const result = hls.recoverMediaErrorBySkippingFrag();

      expect(result).to.deep.equal({
        ok: false,
        reason: 'media currentTime is invalid',
      });

      hls.destroy();
    });

    it('returns ok: false and resets mediaErrorRecoveryState when detachMedia throws', function () {
      const hls = new Hls();
      const media = document.createElement('video');
      media.currentTime = 357.1;
      (hls as any)._media = media;
      (hls as any).started = true;
      (hls as any).streamController = {
        getLevelDetails: () => ({
          fragments: [{ sn: 35, start: 350, duration: 10, end: 360 }],
        }),
        getMainFwdBufferInfo: () => null,
      };

      const errMsg = 'detach exploded';
      const detachStub = sinon
        .stub(hls, 'detachMedia')
        .throws(new Error(errMsg));

      const result = hls.recoverMediaErrorBySkippingFrag();

      expect(result.ok).to.equal(false);
      expect(result.reason).to.include(errMsg);
      expect((hls as any).mediaErrorRecoveryState).to.equal(null);
      // 状态应被回滚到调用前的初始值
      expect((hls as any).lastSkippedBrokenFromTime).to.equal(-1);
      expect((hls as any).lastSkippedBrokenTargetTime).to.equal(-1);
      expect((hls as any).lastBrokenFrameSkipSize).to.equal(0);

      detachStub.restore();
      hls.destroy();
    });
  });
});
