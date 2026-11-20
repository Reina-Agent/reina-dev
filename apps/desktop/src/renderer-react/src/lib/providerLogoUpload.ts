const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_LOGO_LENGTH = 128 * 1024;
const LOGO_SIZE = 128;
const PNG_PREFIX = "data:image/png;base64,";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

export function isProviderLogo(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LOGO_LENGTH || !value.startsWith(PNG_PREFIX)) return false;
  const encoded = value.slice(PNG_PREFIX.length);
  if (encoded.length < 12 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  try {
    return atob(encoded.slice(0, 12)).startsWith("\x89PNG\r\n\x1a\n");
  } catch {
    return false;
  }
}

export async function readProviderLogo(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("models.logoTooLarge");
  const supported = file.type ? IMAGE_TYPES.has(file.type.toLowerCase()) : /\.(?:png|jpe?g|webp|gif|svg)$/i.test(file.name);
  if (!file.size || !supported) throw new Error("models.logoInvalidImage");

  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("models.logoInvalidImage"));
      img.src = objectUrl!;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("models.logoInvalidImage");

    const canvas = document.createElement("canvas");
    canvas.width = LOGO_SIZE;
    canvas.height = LOGO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("models.logoInvalidImage");
    const scale = Math.min(LOGO_SIZE / image.naturalWidth, LOGO_SIZE / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (LOGO_SIZE - width) / 2, (LOGO_SIZE - height) / 2, width, height);
    const logo = canvas.toDataURL("image/png");
    if (!isProviderLogo(logo)) throw new Error("models.logoInvalidImage");
    return logo;
  } catch {
    throw new Error("models.logoInvalidImage");
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
