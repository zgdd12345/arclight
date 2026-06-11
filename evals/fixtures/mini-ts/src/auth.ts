export function verifyToken(payload: { exp: number }): boolean {
  // BUG: exp 是秒级时间戳，与毫秒 Date.now() 直接比较
  if (payload.exp < Date.now()) {
    return false;
  }
  return true;
}
