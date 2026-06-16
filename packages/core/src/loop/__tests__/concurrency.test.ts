import { describe, expect, test } from "bun:test";
import { abortError, isAbortError, Semaphore } from "../concurrency";

describe("Semaphore", () => {
  test("许可耗尽前 acquire 立即返回，耗尽后排队", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);

    let third = false;
    const p3 = sem.acquire().then((rel) => {
      third = true;
      return rel;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.pending).toBe(1);

    r1(); // 释放 → 直接移交给排队者
    const r3 = await p3;
    expect(third).toBe(true);
    r3();
  });

  test("release 幂等：重复调用不漏放许可", async () => {
    const sem = new Semaphore(1);
    const rel = await sem.acquire();
    rel();
    rel();
    expect(sem.available).toBe(1);
  });

  test("等待中被 abort → reject AbortError，且不漏许可", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const ac = new AbortController();
    const p = sem.acquire(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(sem.pending).toBe(0);
    held();
    expect(sem.available).toBe(1);
  });

  test("已 abort 的 signal 直接 reject，不占许可", async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(ac.signal)).rejects.toThrow("aborted");
    expect(sem.available).toBe(1);
  });

  test("非法许可数抛错", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  test("abortError / isAbortError", () => {
    const e = abortError();
    expect(e.name).toBe("AbortError");
    expect(isAbortError(e)).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });
});
