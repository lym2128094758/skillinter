export function imageMime(bytes) {
  if (bytes.length >= 24 && Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      Buffer.from(bytes).subarray(12, 16).toString() === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const header = Buffer.from(bytes).subarray(0, 12).toString('ascii');
  if (bytes.length >= 12 && header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(header.slice(0, 6))) return 'image/gif';
  return null;
}

export function imageMessage(text, file) {
  const mime = file?.kind === 'image' ? imageMime(file.bytes) : null;
  return mime ? [...(text ? [{type: 'text', text}] : []),
    {type: 'image_url', image_url: {url: `data:${mime};base64,${Buffer.from(file.bytes).toString('base64')}`}}] : text;
}
