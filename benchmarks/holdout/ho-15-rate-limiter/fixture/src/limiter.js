export class Limiter {
  constructor(ratePerSecond, windowMs) {
    this.ratePerSecond = ratePerSecond;
    this.windowMs = windowMs;
  }
  allow() {
    return true;
  }
}
