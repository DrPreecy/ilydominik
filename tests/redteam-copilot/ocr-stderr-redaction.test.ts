import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ocrPreview } from '../../src/integrations/ocr.ts';

describe('Copilot R2: OCR child-process diagnostics', () => {
  it('redacts credential-shaped text from a failed child-process diagnostic', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
    const diagnostic = `remote diagnostic ${token}`;
    const script = `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 7;`;

    await assert.rejects(
      ocrPreview({ file: process.execPath, prefix: ['-e', script] }),
      (error: unknown) => error instanceof Error && !error.message.includes(token),
    );
  });
});
