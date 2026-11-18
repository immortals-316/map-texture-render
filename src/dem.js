import { fromFile } from "geotiff";
import { DEFAULT_NODATA } from "./params.js";

function numberList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(Number) : [Number(value)];
}

function frameFromImage(image) {
  const directory = image.fileDirectory;
  const tie = numberList(directory.ModelTiepoint);
  const scale = numberList(directory.ModelPixelScale);
  const width = image.getWidth();
  const height = image.getHeight();
  if (tie.length >= 5 && scale.length >= 2) {
    const west = tie[3];
    const north = tie[4];
    return {
      west,
      north,
      east: west + width * scale[0],
      south: north - height * scale[1],
    };
  }
  const [west, south, east, north] = image.getBoundingBox();
  return { west, south, east, north };
}

export async function openDem(demPath) {
  const tiff = await fromFile(demPath);
  const image = await tiff.getImage();
  if (image.getSamplesPerPixel() !== 1) {
    throw new Error(`DEM must be single-band: ${demPath}`);
  }
  const bits = image.getBitsPerSample();
  if (bits !== 16) {
    throw new Error(`DEM must be 16-bit: ${demPath}`);
  }
  const nodataValue = image.getGDALNoData();
  const nodata = nodataValue == null ? DEFAULT_NODATA : Number(nodataValue);
  const frame = frameFromImage(image);
  return {
    image,
    width: image.getWidth(),
    height: image.getHeight(),
    tileWidth: image.getTileWidth(),
    tileHeight: image.getTileHeight(),
    nodata,
    ...frame,
  };
}

function sourceIndex(start, end, outSize) {
  const span = end - start;
  const index = new Int32Array(outSize);
  for (let i = 0; i < outSize; i += 1) {
    index[i] = Math.min(start + Math.floor(((i + 0.5) * span) / outSize), end - 1);
  }
  return index;
}

export async function readTiledNearest(dem, outWidth, outHeight, onProgress, sourceWindow) {
  const { image, width, height, tileWidth, tileHeight, nodata } = dem;
  const col0 = sourceWindow?.col0 ?? 0;
  const row0 = sourceWindow?.row0 ?? 0;
  const col1 = sourceWindow?.col1 ?? width;
  const row1 = sourceWindow?.row1 ?? height;
  const output = new Int32Array(outHeight * outWidth);
  output.fill(nodata);
  const srcX = sourceIndex(col0, col1, outWidth);
  const srcY = sourceIndex(row0, row1, outHeight);
  const columnsByTile = new Map();
  for (let x = 0; x < outWidth; x += 1) {
    const tileX = Math.floor(srcX[x] / tileWidth);
    const bucket = columnsByTile.get(tileX);
    if (bucket) bucket.push(x);
    else columnsByTile.set(tileX, [x]);
  }
  const rowsByTile = new Map();
  for (let y = 0; y < outHeight; y += 1) {
    const tileY = Math.floor(srcY[y] / tileHeight);
    const bucket = rowsByTile.get(tileY);
    if (bucket) bucket.push(y);
    else rowsByTile.set(tileY, [y]);
  }

  const tileYs = [...rowsByTile.keys()].sort((a, b) => a - b);
  const tileXs = [...columnsByTile.keys()].sort((a, b) => a - b);
  let done = 0;
  let reported = -1;
  const total = Math.max(1, tileYs.length * tileXs.length);
  for (const tileY of tileYs) {
    const rows = rowsByTile.get(tileY);
    for (const tileX of tileXs) {
      done += 1;
      const columns = columnsByTile.get(tileX);
      if (rows && columns) {
        const x0 = tileX * tileWidth;
        const y0 = tileY * tileHeight;
        const x1 = Math.min(x0 + tileWidth, width);
        const y1 = Math.min(y0 + tileHeight, height);
        const windowWidth = x1 - x0;
        const rasters = await image.readRasters({
          window: [x0, y0, x1, y1],
          interleave: false,
        });
        const tile = rasters[0];
        for (const y of rows) {
          const localRow = srcY[y] - y0;
          const rowOffset = localRow * windowWidth;
          const outRow = y * outWidth;
          for (const x of columns) {
            output[outRow + x] = tile[rowOffset + (srcX[x] - x0)];
          }
        }
      }
      if (onProgress) {
        const percent = Math.floor((done * 100) / total);
        if (percent >= reported + 10 || percent === 100) {
          reported = percent;
          onProgress(percent);
        }
      }
    }
  }
  return output;
}
