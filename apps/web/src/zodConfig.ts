import { z } from 'zod';

// Must be imported before any schema is constructed: the strict CSP forbids eval, so run zod
// without its `new Function` JIT (zod probes for eval when an object schema is created).
z.config({ jitless: true });
