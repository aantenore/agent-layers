// Copies the repository LICENSE into the current package folder. Runs from each package's `prepack`, so every
// published tarball carries the license text while the repository keeps a single copy.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/common.mjs';

copyFileSync(join(ROOT, 'LICENSE'), join(process.cwd(), 'LICENSE'));
