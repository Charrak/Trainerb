import sharp from 'sharp';
/** Rebuild pixels after scan+rights review; never publish the file container or its EXIF. */
export async function publicImage(bytes: Buffer, mime: string) {
  const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
  const m = await image.metadata();
  if (!['image/png', 'image/jpeg'].includes(mime) || `image/${m.format}` !== mime || (m.pages ?? 1) !== 1)
    throw Error('Image format mismatch');
  const resized = image.autoOrient().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true });
  const output = await (mime === 'image/png' ? resized.png() : resized.jpeg({ quality: 85 })).toBuffer();
  if (output.length > 5 * 1024 * 1024) throw Error('Encoded image too large');
  return output;
}
