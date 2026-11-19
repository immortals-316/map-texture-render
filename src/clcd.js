import fs from "node:fs";
import path from "node:path";
import { fromFile } from "geotiff";
import proj4 from "proj4";

export const CLCD_STEM_BY_ADCODE = {
  110000: "beijing",
  120000: "tianjin",
  130000: "hebei",
  140000: "shanxi",
  150000: "neimeng",
  210000: "niaoning",
  220000: "jining",
  230000: "heilongjiang",
  310000: "shanghai",
  320000: "jiangsu",
  330000: "zhejiang",
  340000: "anhui",
  350000: "fujian",
  360000: "jiangxi",
  370000: "shandong",
  410000: "henan",
  420000: "hubei",
  430000: "hunan",
  440000: "guangzhou",
  450000: "guangxi",
  460000: "hainan",
  500000: "chongqing",
  510000: "sichuang",
  520000: "guizhou",
  530000: "yunnan",
  540000: "xizang",
  610000: "shaanxi",
  620000: "ganshu",
  630000: "qinghai",
  640000: "ningxia",
  650000: "xinjiang",
  710000: "taiwan",
  810000: "hongkong",
  820000: "macao",
  990901: "hebei",
  990902: "neimeng",
  990101: "huabei",
  990102: "huadong",
  990103: "huazhong",
  990104: "dongbei",
  990105: "xibei",
  990106: "xinan",
  990200: "nanfang",
  990000: "quanguo",
};

export const CLASS_RGB = {
  1: [196, 184, 140],
  2: [74, 112, 72],
  3: [112, 130, 78],
  4: [168, 176, 96],
  5: [120, 148, 160],
  6: [236, 240, 242],
  7: [186, 164, 130],
  8: [150, 148, 144],
  9: [96, 124, 112],
};

// 耕地、建成区铺成纹理底色，叠到纹理上后显示地形明暗。其余类别保留本色。
export const MATERIAL_BASE = [180, 180, 180];
export const MATERIAL_BASE_CODES = new Set([1, 8]);

export function clcdPath(resourcesDir, adcode) {
  const stem = CLCD_STEM_BY_ADCODE[adcode];
  if (!stem) return null;
  const filePath = path.join(resourcesDir, "clcd", `CLCD_v01_2025_albert_${stem}.tif`);
  return fs.existsSync(filePath) ? filePath : null;
}

function projectionOf(image) {
  const keys = image.getGeoKeys();
  if (keys.ProjCoordTransGeoKey !== 11) {
    throw new Error("CLCD raster is not an Albers projection");
  }
  const definition = [
    "+proj=aea",
    `+lat_1=${keys.ProjStdParallel1GeoKey}`,
    `+lat_2=${keys.ProjStdParallel2GeoKey}`,
    `+lat_0=${keys.ProjNatOriginLatGeoKey}`,
    `+lon_0=${keys.ProjNatOriginLongGeoKey}`,
    `+x_0=${keys.ProjFalseEastingGeoKey}`,
    `+y_0=${keys.ProjFalseNorthingGeoKey}`,
    "+datum=WGS84",
    "+units=m",
    "+no_defs",
  ].join(" ");
  return proj4("EPSG:4326", definition);
}

export async function openClcd(filePath) {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const directory = image.fileDirectory;
  const tie = directory.ModelTiepoint;
  const scale = directory.ModelPixelScale;
  if (!tie || !scale) throw new Error(`CLCD is missing georeferencing: ${filePath}`);
  return {
    image,
    width: image.getWidth(),
    height: image.getHeight(),
    tileWidth: image.getTileWidth(),
    tileHeight: image.getTileHeight(),
    originX: tie[3],
    originY: tie[4],
    pixelSize: scale[0],
    project: projectionOf(image),
  };
}

export async function sampleClasses(clcd, frame, gridWidth, workHeight, crop) {
  const cropWidth = crop[2] - crop[0];
  const cropHeight = crop[3] - crop[1];
  const count = cropWidth * cropHeight;
  const classes = new Uint8Array(count);
  const lonStep = (frame.east - frame.west) / Math.max(gridWidth - 1, 1);
  const latStep = (frame.north - frame.south) / Math.max(workHeight - 1, 1);
  const sourceCol = new Int32Array(count);
  const sourceRow = new Int32Array(count);
  sourceCol.fill(-1);
  const tiles = new Map();
  for (let row = 0; row < cropHeight; row += 1) {
    const lat = frame.north - (crop[1] + row) * latStep;
    for (let col = 0; col < cropWidth; col += 1) {
      const lon = frame.west + (crop[0] + col) * lonStep;
      const [x, y] = clcd.project.forward([lon, lat]);
      const pixelCol = Math.floor((x - clcd.originX) / clcd.pixelSize);
      const pixelRow = Math.floor((clcd.originY - y) / clcd.pixelSize);
      const index = row * cropWidth + col;
      if (pixelCol < 0 || pixelRow < 0 || pixelCol >= clcd.width || pixelRow >= clcd.height) continue;
      sourceCol[index] = pixelCol;
      sourceRow[index] = pixelRow;
      const tileX = Math.floor(pixelCol / clcd.tileWidth);
      const tileY = Math.floor(pixelRow / clcd.tileHeight);
      const key = `${tileX}:${tileY}`;
      const bucket = tiles.get(key);
      if (bucket) bucket.push(index);
      else tiles.set(key, [index]);
    }
  }
  for (const [key, indexes] of tiles) {
    const [tileX, tileY] = key.split(":").map(Number);
    const x0 = tileX * clcd.tileWidth;
    const y0 = tileY * clcd.tileHeight;
    const x1 = Math.min(x0 + clcd.tileWidth, clcd.width);
    const y1 = Math.min(y0 + clcd.tileHeight, clcd.height);
    const rasters = await clcd.image.readRasters({ window: [x0, y0, x1, y1], interleave: false });
    const tile = rasters[0];
    const tileWidth = x1 - x0;
    for (const index of indexes) {
      classes[index] = tile[(sourceRow[index] - y0) * tileWidth + (sourceCol[index] - x0)];
    }
  }
  return classes;
}

export function colorize(classes) {
  const rgb = new Uint8Array(classes.length * 3);
  const coverage = new Uint8Array(classes.length);
  for (let index = 0; index < classes.length; index += 1) {
    const color = CLASS_RGB[classes[index]];
    if (!color) continue;
    rgb[index * 3] = color[0];
    rgb[index * 3 + 1] = color[1];
    rgb[index * 3 + 2] = color[2];
    coverage[index] = 255;
  }
  return { rgb, coverage };
}
