// Preact keeps its effect queue across UI test files. Closing one Happy DOM window cancels its animation frames;
// use the process scheduler so a pending flush still runs before or during the next file's window.
import { options } from "preact";
import { GlobalRegistrator as HappyDOM } from "@happy-dom/global-registrator";
const pending = new Set<() => void>();
options.requestAnimationFrame = callback => {
  pending.add(callback);
  void Bun.sleep(0).then(() => { if (pending.delete(callback)) callback(); });
};
export const GlobalRegistrator = {
  get isRegistered() { return HappyDOM.isRegistered; },
  register: HappyDOM.register.bind(HappyDOM),
  async unregister() {
    // Unmount cleanups can still use window/document, so finish them before removing those globals.
    await Bun.sleep(0);
    while (pending.size) {
      const callbacks = [...pending]; pending.clear();
      for (const callback of callbacks) callback();
      await Bun.sleep(0);
    }
    await HappyDOM.unregister();
  },
};
