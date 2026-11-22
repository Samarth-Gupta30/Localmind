import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import documentRoutes from '../src/routes/document.routes';
import { uploadDocument } from '../src/controllers/document.controller';
import { ChunkingService } from '../src/services/chunking.service';

function makeMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test('uploadDocument rejects missing file and 0-byte empty file with 400', async () => {
  const resMissing = makeMockRes();
  await uploadDocument({ file: undefined } as any, resMissing);
  assert.equal(resMissing.statusCode, 400);

  const resEmpty = makeMockRes();
  await uploadDocument(
    {
      file: {
        originalname: 'empty.txt',
        size: 0,
        buffer: Buffer.alloc(0),
      },
    } as any,
    resEmpty
  );
  assert.equal(resEmpty.statusCode, 400);
  assert.match(resEmpty.body.error, /empty/i);
});

test('uploadDocument rejects invalid PDF magic header with 400', async () => {
  const res = makeMockRes();
  await uploadDocument(
    {
      file: {
        originalname: 'fake.pdf',
        size: 16,
        buffer: Buffer.from('NOT_A_PDF_HEADER'),
      },
    } as any,
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /corrupted|valid PDF/i);
});

test('ChunkingService fast-fails on corrupted PDF bytes without throwing 500', async () => {
  const chunker = new ChunkingService();
  await assert.rejects(
    chunker.extractText(Buffer.from('%PDF-1.4\n%%corrupted-garbage'), 'broken.pdf'),
    (err: any) => err.statusCode === 400
  );
});

test('handleUploadMiddleware returns JSON 413 when file exceeds 10MB', async () => {
  const app = express();
  app.use('/api/documents', documentRoutes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };

  try {
    const form = new FormData();
    const bigBlob = new Blob([Buffer.alloc(10 * 1024 * 1024 + 1024, 'a')], {
      type: 'text/plain',
    });
    form.append('file', bigBlob, 'oversized.txt');

    const response = await fetch(`http://127.0.0.1:${addr.port}/api/documents/upload`, {
      method: 'POST',
      body: form,
    });

    assert.equal(response.status, 413);
    const json = (await response.json()) as { error: string };
    assert.match(json.error, /10MB/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('concurrent invalid uploads resolve cleanly without crashing', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => {
      const res = makeMockRes();
      return uploadDocument(
        {
          file: {
            originalname: `bad-${i}.pdf`,
            size: 10,
            buffer: Buffer.from('corrupt-123'),
          },
        } as any,
        res
      ).then(() => res);
    })
  );

  for (const r of results) {
    assert.equal(r.statusCode, 400);
  }
});