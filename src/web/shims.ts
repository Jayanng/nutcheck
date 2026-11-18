// Browser shims for Node built-ins (Buffer and Stream)
import { Buffer } from 'buffer';

if (typeof globalThis !== 'undefined' && !globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

export { Buffer };

