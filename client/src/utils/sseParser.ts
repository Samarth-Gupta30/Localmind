export interface ParsedSSECallbacks {
  onEvent: (data: Record<string, unknown>) => void;
  onParseError?: (raw: string, err: unknown) => void;
}

export function createSSEParser({ onEvent, onParseError }: ParsedSSECallbacks) {
  let buffer = '';

  const processEventBlock = (rawBlock: string) => {
    const lines = rawBlock.split(/\r?\n/);
    const dataLines: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(':')) continue;

      if (trimmedLine.startsWith('data:')) {
        dataLines.push(trimmedLine.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;

    const jsonString = dataLines.join('\n');
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed && typeof parsed === 'object') {
        onEvent(parsed as Record<string, unknown>);
      }
    } catch (err) {
      onParseError?.(jsonString, err);
    }
  };

  return {
    feed(chunkText: string) {
      buffer += chunkText;
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const rawBlock of parts) {
        processEventBlock(rawBlock);
      }
    },
    flush() {
      if (buffer.trim()) {
        processEventBlock(buffer.trim());
        buffer = '';
      }
    },
  };
}