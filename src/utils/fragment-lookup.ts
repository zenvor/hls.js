import type { MediaFragment } from '../loader/fragment';

export const FRAG_LOOKUP_TOLERANCE = 0.05;

export function getMainFragmentEnd(frag: MediaFragment): number {
  return typeof frag.end === 'number' ? frag.end : frag.start + frag.duration;
}

export function findCurrentMainFragment(
  fragments: MediaFragment[] | undefined,
  currentTime: number,
  offset: number,
  tolerance: number = FRAG_LOOKUP_TOLERANCE,
): MediaFragment | null {
  if (!fragments?.length || !Number.isFinite(currentTime)) {
    return null;
  }
  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i];
    const fragEnd = getMainFragmentEnd(frag);
    if (
      currentTime >= frag.start - tolerance &&
      currentTime < fragEnd - offset
    ) {
      return frag;
    }
  }
  return null;
}
