/** True for Safari (including iOS), false for Chrome/Edge/Firefox (incl. Chrome on iOS). */
export function isSafariBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  const isSafari = /Safari/i.test(ua) && !/Chrom(e|ium)|Edg|OPR|Firefox/i.test(ua);
  const isIOSSafari =
    /iP(hone|ad|od)/i.test(ua) && /WebKit/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return isSafari || isIOSSafari;
}
