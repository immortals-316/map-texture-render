import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import { findJob, jobsForLayer } from "./catalog.js";
import { openDem, readTiledNearest } from "./dem.js";
import {
  boxMean,
  castShadowFactor,
  hillshade,
  maskedBoxMean,
  resizeGray,
  resizeRgba,
  separableBlur,
} from "./image.js";
import {
  ADCODE_PINYIN,
  CAST_HEIGHT_BIAS_M,
  CAST_MAX_DIST_M,
  CAST_SHADE,
  CAST_SHADOW,
  CAST_STEP_PX,
  CAST_Z_EXAG,
  DEFAULT_ASPECT_SCALE,
  DEFAULT_CANVAS,
  DEFAULT_MAX_PLACED,
  DEFAULT_NODATA,
  DEFAULT_SUPERSAMPLE,
  DEFAULT_WORK_WIDTH,
  FLAT_SHADE,
  FLAT_SHADE_GAMMA,
  GRAY_UNSHARP_AMOUNT,
  HILLSHADE_ALTITUDE_DEG,
  HILLSHADE_AZIMUTH_DEG,
  HILLSHADE_COARSE_EXAGGERATION,
  HILLSHADE_COARSE_WEIGHT,
  HILLSHADE_CONTRAST,
  HILLSHADE_DETAIL,
  HILLSHADE_FINE_EXAGGERATION,
  HILLSHADE_FINE_WEIGHT,
  LAKE_OVERLAY_ALPHA,
  LAKE_OVERLAY_GRAY,
  SHADE_BASE_WEIGHT,
  SHADE_RELIEF_WEIGHT,
  SLOPE_REF,
  TERRAIN_BASE_GRAY,
  TONE_GRAY_FLOOR,
  TONE_GRAY_MAX,
} from "./params.js";
import {
  loadGeojson,
  polygons,
  rasterizePolygons,
  rasterizeProjected,
  readShapefilePolygons,
} from "./vector.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.resolve(
  process.env.TERRAIN_RESOURCES || path.join(repoDir, "..", "province-terrain-resources"),
);

const PROVINCE_NAMES = {
  110000: "北京市",
  120000: "天津市",
  130000: "河北省",
  140000: "山西省",
  150000: "内蒙古自治区",
  210000: "辽宁省",
  220000: "吉林省",
  230000: "黑龙江省",
  310000: "上海市",
  320000: "江苏省",
  330000: "浙江省",
  340000: "安徽省",
  350000: "福建省",
  360000: "江西省",
  370000: "山东省",
  410000: "河南省",
  420000: "湖北省",
  430000: "湖南省",
  440000: "广东省",
  450000: "广西壮族自治区",
  460000: "海南省",
  500000: "重庆市",
  510000: "四川省",
  520000: "贵州省",
  530000: "云南省",
  540000: "西藏自治区",
  610000: "陕西省",
  620000: "甘肃省",
  630000: "青海省",
  640000: "宁夏回族自治区",
  650000: "新疆维吾尔自治区",
  710000: "台湾省",
  810000: "香港特别行政区",
  820000: "澳门特别行政区",
  990000: "全国",
  990101: "华北",
  990102: "华东",
  990103: "华中",
  990104: "东北",
  990105: "西北",
  990106: "西南",
  990200: "南方",
  990901: "冀北",
  990902: "蒙东",
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function clip(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function codeOf(adcode) {
  const text = String(adcode);
  return /^\d+$/.test(text) ? text.padStart(6, "0") : text;
}

function resolveDem(directory, name) {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  if (!fs.existsSync(directory)) throw new Error(`DEM directory not found: ${directory}`);
  const direct = path.join(directory, name);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(name)) {
    for (const suffix of [".tif", ".tiff", ".TIF", ".TIFF"]) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    const token = name.toLowerCase();
    const exact = [];
    const prefixed = [];
    for (const file of fs.readdirSync(directory)) {
      const suffix = path.extname(file);
      if (![".tif", ".tiff", ".TIF", ".TIFF"].includes(suffix)) continue;
      const stem = path.basename(file, suffix).toLowerCase();
      const first = stem.split("_")[0];
      const full = path.join(directory, file);
      if (first === token) exact.push(full);
      else if (stem.startsWith(token)) prefixed.push(full);
    }
    const matches = exact.length ? exact : prefixed;
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `DEM name ${name} is ambiguous: ${matches.map((item) => path.basename(item)).join(", ")}`,
      );
    }
  }
  throw new Error(`DEM not found: ${name}`);
}

function pinyinStem(adcode, dem) {
  const code = codeOf(adcode);
  if (ADCODE_PINYIN[code]) return ADCODE_PINYIN[code];
  const demStem = dem ? path.basename(dem, path.extname(dem)).split("_")[0] : "";
  const cleaned = (demStem || code).replace(/[^A-Za-z0-9_-]+/g, "");
  return cleaned || code;
}

function inferName(mapPath, data) {
  const match = path.basename(mapPath).match(/(?<!\d)(\d{6})(?!\d)/);
  if (match && PROVINCE_NAMES[match[1]]) return PROVINCE_NAMES[match[1]];
  if (data.features.length === 1) {
    const name = String(data.features[0].properties?.name || "");
    if (name) return name;
  }
  const adcodes = data.features
    .map((feature) => feature.properties?.adcode)
    .filter((value) => value != null && /^\d+$/.test(String(value)))
    .map((value) => String(value).padStart(6, "0"));
  if (adcodes.length && adcodes.every((code) => code.startsWith(adcodes[0].slice(0, 2)))) {
    return PROVINCE_NAMES[`${adcodes[0].slice(0, 2)}0000`] || path.basename(mapPath, ".json");
  }
  return path.basename(mapPath, ".json");
}

function coordinateBounds(data) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  let count = 0;
  for (const polygon of polygons(data)) {
    for (const ring of polygon) {
      for (const point of ring) {
        west = Math.min(west, point[0]);
        east = Math.max(east, point[0]);
        south = Math.min(south, point[1]);
        north = Math.max(north, point[1]);
        count += 1;
      }
    }
  }
  if (!count) throw new Error("GeoJSON contains no coordinates");
  return { west, east, south, north, count };
}

function geojsonStats(data) {
  const shapes = polygons(data);
  let ringCount = 0;
  let holeCount = 0;
  let coordinateCount = 0;
  for (const polygon of shapes) {
    ringCount += polygon.length;
    holeCount += Math.max(0, polygon.length - 1);
    for (const ring of polygon) coordinateCount += ring.length;
  }
  return {
    feature_count: data.features.length,
    polygon_count: shapes.length,
    ring_count: ringCount,
    hole_count: holeCount,
    coordinate_count: coordinateCount,
  };
}

function prepareTerrain(dem, valid, width, height) {
  const raw = Float32Array.from(dem);
  const local = maskedBoxMean(raw, valid, width, height, 1);
  const terrain = new Float32Array(dem.length);
  const halo = Uint8Array.from(valid);
  for (let i = 0; i < dem.length; i += 1) {
    if (valid[i]) terrain[i] = raw[i] * 0.94 + local[i] * 0.06;
  }
  for (let pass = 0; pass < 4; pass += 1) {
    const expanded = maskedBoxMean(terrain, halo, width, height, 1);
    for (let i = 0; i < dem.length; i += 1) {
      if (!halo[i] && Number.isFinite(expanded[i])) {
        terrain[i] = expanded[i];
        halo[i] = 1;
      }
    }
  }
  for (let i = 0; i < dem.length; i += 1) {
    if (!halo[i]) terrain[i] = Number.NaN;
  }
  return { terrain, halo };
}

function shadeOptions(exaggeration) {
  return {
    azimuth: HILLSHADE_AZIMUTH_DEG,
    altitude: HILLSHADE_ALTITUDE_DEG,
    exaggeration,
    flatShade: FLAT_SHADE,
    slopeRef: SLOPE_REF,
    flatGamma: FLAT_SHADE_GAMMA,
  };
}

function multiscaleShade(terrain, halo, width, height, cellX, cellY) {
  const fine = hillshade(
    terrain,
    halo,
    width,
    height,
    cellX,
    cellY,
    shadeOptions(HILLSHADE_FINE_EXAGGERATION),
  );
  const coarseTerrain = maskedBoxMean(terrain, halo, width, height, 5);
  const coarse = hillshade(
    coarseTerrain,
    halo,
    width,
    height,
    cellX,
    cellY,
    shadeOptions(HILLSHADE_COARSE_EXAGGERATION),
  );
  const combined = new Float32Array(terrain.length);
  for (let i = 0; i < combined.length; i += 1) {
    combined[i] = fine[i] * HILLSHADE_FINE_WEIGHT + coarse[i] * HILLSHADE_COARSE_WEIGHT;
  }
  const neighborhood = boxMean(combined, width, height, 2);
  const sharpened = new Float32Array(combined.length);
  for (let i = 0; i < sharpened.length; i += 1) {
    sharpened[i] = clip(
      0.5 +
        (combined[i] - 0.5) * HILLSHADE_CONTRAST +
        (combined[i] - neighborhood[i]) * HILLSHADE_DETAIL,
      0,
      1,
    );
  }
  return sharpened;
}

function paintLakes(gray, valid, lakePaths, width, height, frame) {
  const shapes = [];
  for (const lakePath of lakePaths) {
    shapes.push(
      ...readShapefilePolygons(lakePath, {
        west: frame.west,
        south: frame.south,
        east: frame.east,
        north: frame.north,
      }),
    );
  }
  let lakeMask = new Uint8Array(width * height);
  if (shapes.length) {
    lakeMask = rasterizePolygons(shapes, frame, width, height);
    for (let i = 0; i < lakeMask.length; i += 1) {
      if (!valid[i]) lakeMask[i] = 0;
    }
  }
  const softSource = new Float32Array(lakeMask.length);
  let pixels = 0;
  for (let i = 0; i < lakeMask.length; i += 1) {
    if (lakeMask[i]) {
      softSource[i] = 255;
      pixels += 1;
    }
  }
  const soft = separableBlur(softSource, width, height, 0.7);
  for (let i = 0; i < gray.length; i += 1) {
    if (!valid[i]) continue;
    const fillAlpha = Math.round(soft[i] * LAKE_OVERLAY_ALPHA);
    const weight = fillAlpha / 255;
    gray[i] = clip(
      Math.round(LAKE_OVERLAY_GRAY * weight + gray[i] * (1 - weight)),
      0,
      255,
    );
  }
  return {
    enabled: true,
    style: "overlay",
    sources: lakePaths.map((item) => path.resolve(item)),
    fill: `#${LAKE_OVERLAY_GRAY.toString(16).padStart(2, "0").repeat(3)}`,
    overlayAlpha: LAKE_OVERLAY_ALPHA,
    edge: null,
    featureCountIntersectingDEM: shapes.length,
    pixels,
  };
}

function linearQuantile(sorted, percent) {
  if (sorted.length === 1) return sorted[0];
  const rank = (percent / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] * (high - rank) + sorted[high] * (rank - low);
}

function alphaBBox(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (rgba[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return [minX, minY, maxX + 1, maxY + 1];
}

function writePng(filePath, rgba, width, height) {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

async function renderMap(options) {
  const {
    demPath,
    mapPath,
    data: suppliedData,
    outputPath,
    reportPath,
    name,
    layer,
    adcode,
    canvasWidth,
    canvasHeight,
    workWidth: maxWorkWidth,
    supersample,
    aspectScale,
    nodataFallback,
    lakePaths,
  } = options;
  if (maxWorkWidth < 100) throw new Error("work width must be at least 100 pixels");
  if (supersample < 1) throw new Error("supersample must be at least 1");
  if (aspectScale <= 0) throw new Error("aspect scale must be greater than zero");

  const data = suppliedData || loadGeojson(mapPath);
  const displayName = name || inferName(mapPath, data);
  const mapBounds = coordinateBounds(data);
  const dem = await openDem(demPath);
  const nodata = Number.isFinite(dem.nodata) ? dem.nodata : nodataFallback;
  const { west: demWest, south: demSouth, east: demEast, north: demNorth } = dem;
  const overlapWest = Math.max(demWest, mapBounds.west);
  const overlapEast = Math.min(demEast, mapBounds.east);
  const overlapSouth = Math.max(demSouth, mapBounds.south);
  const overlapNorth = Math.min(demNorth, mapBounds.north);
  if (overlapWest >= overlapEast || overlapSouth >= overlapNorth) {
    throw new Error(
      `Map and DEM do not overlap (DEM WESN=${demWest},${demEast},${demSouth},${demNorth}; map WESN=${mapBounds.west},${mapBounds.east},${mapBounds.south},${mapBounds.north})`,
    );
  }
  let outside = false;
  for (const polygon of polygons(data)) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon < demWest || lon > demEast || lat < demSouth || lat > demNorth) outside = true;
      }
    }
  }
  const demClipWarning = outside
    ? `Map extends outside DEM bounds; rendering DEM∩map only. DEM E=${demEast.toFixed(6)} vs map E=${mapBounds.east.toFixed(6)}; DEM W=${demWest.toFixed(6)} vs map W=${mapBounds.west.toFixed(6)}; DEM N=${demNorth.toFixed(6)} vs map N=${mapBounds.north.toFixed(6)}; DEM S=${demSouth.toFixed(6)} vs map S=${mapBounds.south.toFixed(6)}`
    : null;

  const scaleX = (demEast - demWest) / dem.width;
  const scaleY = (demNorth - demSouth) / dem.height;
  const col0 = Math.max(0, Math.min(dem.width - 1, Math.floor((overlapWest - demWest) / scaleX)));
  const col1 = Math.max(col0 + 1, Math.min(dem.width, Math.ceil((overlapEast - demWest) / scaleX)));
  const row0 = Math.max(0, Math.min(dem.height - 1, Math.floor((demNorth - overlapNorth) / scaleY)));
  const row1 = Math.max(row0 + 1, Math.min(dem.height, Math.ceil((demNorth - overlapSouth) / scaleY)));
  const west = demWest + col0 * scaleX;
  const east = demWest + col1 * scaleX;
  const north = demNorth - row0 * scaleY;
  const south = demNorth - row1 * scaleY;
  const sourceWidth = col1 - col0;
  const sourceHeight = row1 - row0;
  const gridWidth = Math.max(1, Math.min(maxWorkWidth, sourceWidth));
  const workHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * gridWidth));
  log(
    `tiled_read window ${sourceWidth}x${sourceHeight} of ${dem.width}x${dem.height} -> ${gridWidth}x${workHeight}`,
  );
  const sampled = await readTiledNearest(
    dem,
    gridWidth,
    workHeight,
    (percent) => {
      log(`tiled_read=${percent}%`);
    },
    { col0, row0, col1, row1 },
  );
  const frame = { west, south, east, north };
  const admin = rasterizePolygons(polygons(data), frame, gridWidth, workHeight);
  const valid = new Uint8Array(sampled.length);
  const elevations = [];
  for (let i = 0; i < sampled.length; i += 1) {
    if (sampled[i] !== nodata && admin[i]) {
      valid[i] = 1;
      elevations.push(sampled[i]);
    }
  }
  if (!elevations.length) throw new Error("DEM contains no valid pixels inside the map geometry");

  const { terrain, halo } = prepareTerrain(sampled, valid, gridWidth, workHeight);
  const latitude = (north + south) / 2;
  const cellX =
    ((east - west) * 111320 * Math.cos((latitude * Math.PI) / 180)) / Math.max(gridWidth, 1);
  const cellY = ((north - south) * 111320) / Math.max(workHeight, 1);
  log(`terrain_cells≈${cellX.toFixed(1)}m x ${cellY.toFixed(1)}m; hillshade…`);
  const localShade = multiscaleShade(terrain, halo, gridWidth, workHeight, cellX, cellY);

  let castFactor = new Float32Array(sampled.length);
  castFactor.fill(1);
  let castStats = { enabled: false, shadowPixels: 0 };
  if (CAST_SHADOW) {
    log("cast_shadow…");
    const cast = castShadowFactor(
      terrain,
      valid,
      gridWidth,
      workHeight,
      cellX,
      cellY,
      {
        azimuth: HILLSHADE_AZIMUTH_DEG,
        altitude: HILLSHADE_ALTITUDE_DEG,
        maxDist: CAST_MAX_DIST_M,
        stepPx: CAST_STEP_PX,
        zExag: CAST_Z_EXAG,
        heightBias: CAST_HEIGHT_BIAS_M,
        castShade: CAST_SHADE,
      },
      (percent) => log(`cast_shadow=${percent}%`),
    );
    castFactor = cast.factor;
    castStats = {
      enabled: true,
      shadowPixels: cast.shadowPixels,
      maxSteps: cast.maxSteps,
      meterPerStep: Math.round(cast.meterPerStep * 100) / 100,
      maxDistanceM: CAST_MAX_DIST_M,
      zExaggeration: CAST_Z_EXAG,
      castShade: CAST_SHADE,
      cellSizeM: [Math.round(cellX * 100) / 100, Math.round(cellY * 100) / 100],
    };
    log(`cast_shadow done (shadowPixels=${cast.shadowPixels})`);
  }

  const gray = new Float32Array(sampled.length);
  for (let i = 0; i < gray.length; i += 1) {
    const shade = clip(localShade[i] * castFactor[i], 0, 1);
    gray[i] = clip(
      TERRAIN_BASE_GRAY * (SHADE_BASE_WEIGHT + SHADE_RELIEF_WEIGHT * shade),
      TONE_GRAY_FLOOR,
      TONE_GRAY_MAX,
    );
  }
  const grayNeighborhood = boxMean(gray, gridWidth, workHeight, 1);
  const grayU8 = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    if (!valid[i]) continue;
    grayU8[i] = clip(
      Math.trunc(gray[i] + (gray[i] - grayNeighborhood[i]) * GRAY_UNSHARP_AMOUNT),
      TONE_GRAY_FLOOR,
      TONE_GRAY_MAX,
    );
  }

  let lakeStats = { enabled: false };
  if (lakePaths?.length) {
    for (const lakePath of lakePaths) {
      if (!fs.existsSync(lakePath)) throw new Error(`Lakes shapefile not found: ${lakePath}`);
    }
    lakeStats = paintLakes(grayU8, valid, lakePaths, gridWidth, workHeight, frame);
  }

  const coverage = new Float32Array(valid.length);
  for (let i = 0; i < valid.length; i += 1) coverage[i] = valid[i] ? 255 : 0;
  const softAlpha = separableBlur(coverage, gridWidth, workHeight, 0.55);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons(data)) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        const x = ((lon - west) / (east - west)) * (gridWidth - 1);
        const y = ((north - lat) / (north - south)) * (workHeight - 1);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const crop = [
    Math.max(0, Math.floor(minX) - 6),
    Math.max(0, Math.floor(minY) - 6),
    Math.min(gridWidth, Math.ceil(maxX) + 1 + 6),
    Math.min(workHeight, Math.ceil(maxY) + 1 + 6),
  ];
  const cropWidth = crop[2] - crop[0];
  const cropHeight = crop[3] - crop[1];
  const premultiplied = new Float32Array(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const source = (y + crop[1]) * gridWidth + (x + crop[0]);
      const alpha = softAlpha[source];
      const color = grayU8[source] * (alpha / 255);
      const offset = (y * cropWidth + x) * 4;
      premultiplied[offset] = color;
      premultiplied[offset + 1] = color;
      premultiplied[offset + 2] = color;
      premultiplied[offset + 3] = alpha;
    }
  }

  const maxPlacedWidth = Math.round((canvasWidth * DEFAULT_MAX_PLACED[0]) / DEFAULT_CANVAS[0]);
  const maxPlacedHeight = Math.round((canvasHeight * DEFAULT_MAX_PLACED[1]) / DEFAULT_CANVAS[1]);
  const displayWidth = cropWidth * aspectScale;
  const fit = Math.min(maxPlacedWidth / displayWidth, maxPlacedHeight / cropHeight);
  const placedWidth = Math.round(displayWidth * fit);
  const placedHeight = Math.round(cropHeight * fit);
  log(`place ${cropWidth}x${cropHeight} -> ${placedWidth}x${placedHeight}`);
  const placed = resizeRgba(premultiplied, cropWidth, cropHeight, placedWidth, placedHeight);
  for (let i = 0; i < placedWidth * placedHeight; i += 1) {
    const offset = i * 4;
    const alpha = placed[offset + 3];
    if (alpha <= 0) {
      placed[offset] = 0;
      placed[offset + 1] = 0;
      placed[offset + 2] = 0;
      placed[offset + 3] = 0;
      continue;
    }
    const scale = 255 / alpha;
    placed[offset] = clip(Math.round(placed[offset] * scale), 0, 255);
    placed[offset + 1] = clip(Math.round(placed[offset + 1] * scale), 0, 255);
    placed[offset + 2] = clip(Math.round(placed[offset + 2] * scale), 0, 255);
    placed[offset + 3] = clip(Math.round(alpha), 0, 255);
  }

  const originX = Math.floor((canvasWidth - placedWidth) / 2);
  const originY = Math.floor((canvasHeight - placedHeight) / 2);
  const canvas = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  for (let y = 0; y < placedHeight; y += 1) {
    const target = ((y + originY) * canvasWidth + originX) * 4;
    canvas.set(placed.subarray(y * placedWidth * 4, (y + 1) * placedWidth * 4), target);
  }

  const highWidth = canvasWidth * supersample;
  const highHeight = canvasHeight * supersample;
  const projected = polygons(data).map((rings) =>
    rings.map((ring) =>
      ring.map(([lon, lat]) => {
        const workX = ((lon - west) / (east - west)) * (gridWidth - 1);
        const workY = ((north - lat) / (north - south)) * (workHeight - 1);
        const x = originX + ((workX - crop[0]) * placedWidth) / cropWidth;
        const y = originY + ((workY - crop[1]) * placedHeight) / cropHeight;
        return [Math.round(x * supersample), Math.round(y * supersample)];
      }),
    ),
  );
  log(`vector_alpha ${highWidth}x${highHeight}`);
  const highMask = rasterizeProjected(projected, highWidth, highHeight);
  const exactAlpha = resizeGray(highMask, highWidth, highHeight, canvasWidth, canvasHeight);
  for (let i = 0; i < canvasWidth * canvasHeight; i += 1) {
    const offset = i * 4;
    const alpha = clip(Math.round(exactAlpha[i]), 0, 255);
    canvas[offset + 3] = alpha;
    if (alpha === 0) {
      canvas[offset] = 0;
      canvas[offset + 1] = 0;
      canvas[offset + 2] = 0;
    } else {
      canvas[offset] = Math.min(canvas[offset], TONE_GRAY_MAX);
      canvas[offset + 1] = Math.min(canvas[offset + 1], TONE_GRAY_MAX);
      canvas[offset + 2] = Math.min(canvas[offset + 2], TONE_GRAY_MAX);
    }
  }

  writePng(outputPath, canvas, canvasWidth, canvasHeight);
  const sorted = elevations.slice().sort((a, b) => a - b);
  const quantilePercents = [1, 25, 50, 75, 90, 95, 99, 99.7];
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(mapPath));
  const report = {
    name: displayName,
    dem: path.resolve(demPath),
    map: path.resolve(mapPath),
    map_sha256: hash.digest("hex"),
    output: path.resolve(outputPath),
    output_size: [canvasWidth, canvasHeight],
    output_mode: "RGBA",
    alpha_bbox: alphaBBox(canvas, canvasWidth, canvasHeight),
    dem_source_size: [dem.width, dem.height],
    dem_window_pixels: [col0, row0, col1, row1],
    working_size: [gridWidth, workHeight],
    layer: layer || null,
    adcode: adcode || null,
    dem_bounds_wsen: [west, south, east, north],
    nodata,
    sampled_elevation_range_m: [sorted[0], sorted[sorted.length - 1]],
    sampled_quantiles_m: quantilePercents.map((percent) =>
      Math.round(linearQuantile(sorted, percent) * 10) / 10,
    ),
    tone_curve: `uniform base #${TERRAIN_BASE_GRAY.toString(16)}${TERRAIN_BASE_GRAY.toString(16)}${TERRAIN_BASE_GRAY.toString(16)}; lighting-only (local hillshade x cast shadow); NW ${HILLSHADE_AZIMUTH_DEG}deg / ${HILLSHADE_ALTITUDE_DEG}deg`,
    hillshade: `northwest ${HILLSHADE_AZIMUTH_DEG} degrees; fine+coarse multiscale; strong sharpen; flat-shade clamp`,
    cast_shadow: castStats,
    lakes: lakeStats,
    echarts_geojson_raw_transform: true,
    display_aspect_scale: aspectScale,
    vector_alpha_supersample: supersample,
    crop_policy: "full-source-boundary",
    outside_boundary: "transparent",
    map_coordinate_bounds: [mapBounds.west, mapBounds.south, mapBounds.east, mapBounds.north],
    all_map_vertices_inside_dem_bounds: !outside,
    dem_clip_warning: demClipWarning,
    map_stats: geojsonStats(data),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(outputPath);
  return outputPath;
}

function demDirectory(resolution) {
  if (resolution === 30) return path.join(resourcesDir, "DEM");
  if (resolution === 200) return path.join(resourcesDir, "DEM_200");
  throw new Error("Unsupported DEM resolution; expected 30 or 200");
}

function outputDirs(resolution) {
  const root = path.join(resourcesDir, "outputs");
  if (resolution === 30) return { pngs: path.join(root, "pngs"), reports: path.join(root, "reports") };
  return { pngs: path.join(root, "pngs_200"), reports: path.join(root, "reports_200") };
}

function defaultLakes() {
  return [
    path.join(resourcesDir, "lake", "LakeDataset_China.shp"),
    path.join(resourcesDir, "natural-earth", "ne_10m_lakes.shp"),
  ];
}

function parseCanvas(value) {
  const match = String(value).match(/^(\d+)[xX,](\d+)$/);
  if (!match) throw new Error(`Invalid canvas size: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      layer: { type: "string" },
      parent: { type: "string" },
      "dem-res": { type: "string", default: "30" },
      output: { type: "string", short: "o" },
      report: { type: "string" },
      name: { type: "string" },
      canvas: { type: "string", default: `${DEFAULT_CANVAS[0]}x${DEFAULT_CANVAS[1]}` },
      "work-width": { type: "string", default: String(DEFAULT_WORK_WIDTH) },
      supersample: { type: "string", default: String(DEFAULT_SUPERSAMPLE) },
      "aspect-scale": { type: "string", default: String(DEFAULT_ASPECT_SCALE) },
      nodata: { type: "string", default: String(DEFAULT_NODATA) },
      "lakes-shp": { type: "string", multiple: true },
      "no-lakes": { type: "boolean", default: false },
      "continue-on-error": { type: "boolean", default: false },
    },
  });

  const resolution = Number(values["dem-res"]);
  const directory = demDirectory(resolution);
  if (!fs.existsSync(directory)) throw new Error(`DEM directory for ${resolution} m not found: ${directory}`);
  log(`DEM dir (${resolution} m): ${directory}`);
  const [canvasWidth, canvasHeight] = parseCanvas(values.canvas);
  const lakePaths = values["no-lakes"] ? null : values["lakes-shp"] || defaultLakes();
  const shared = {
    canvasWidth,
    canvasHeight,
    workWidth: Number(values["work-width"]),
    supersample: Number(values.supersample),
    aspectScale: Number(values["aspect-scale"]),
    nodataFallback: Number(values.nodata),
    lakePaths,
  };
  const dirs = outputDirs(resolution);

  function pathsFor(job) {
    const nested = job.layer === "city" || job.layer === "district";
    const stem = nested ? job.adcode : pinyinStem(job.adcode, job.demPrefix || "");
    const folder = nested ? job.layer : "";
    return {
      outputPath: path.join(dirs.pngs, folder, `${stem}.png`),
      reportPath: path.join(dirs.reports, folder, `${stem}.json`),
    };
  }

  async function renderJob(job, overrides = {}) {
    if (!job.demPrefix) throw new Error(`No DEM mapping for ${job.name} (${job.adcode})`);
    const demPath = resolveDem(directory, overrides.demName || job.demPrefix);
    if (overrides.demName) {
      const expected = resolveDem(directory, job.demPrefix);
      if (path.resolve(demPath) !== path.resolve(expected)) {
        throw new Error(`${job.name} uses DEM ${job.demPrefix}, got ${overrides.demName}`);
      }
    }
    const paths = pathsFor(job);
    log(`${job.layer} ${job.name} (${job.adcode}) ← ${path.basename(demPath)}`);
    await renderMap({
      ...shared,
      demPath,
      mapPath: job.filePath,
      data: { type: "FeatureCollection", features: [job.feature] },
      outputPath: overrides.output || paths.outputPath,
      reportPath: overrides.report || paths.reportPath,
      name: overrides.name || job.name,
      layer: job.layer,
      adcode: job.adcode,
    });
  }

  async function renderJobs(jobs) {
    if (!jobs.length) throw new Error("No renderable regions found");
    let ok = 0;
    const failed = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      log(`[${index + 1}/${jobs.length}] ${job.layer} ${job.name} (${job.adcode})`);
      try {
        await renderJob(job);
        ok += 1;
      } catch (error) {
        failed.push(`${job.adcode}: ${error.message}`);
        log(`  !! ${error.message}`);
        if (!values["continue-on-error"]) throw error;
      }
    }
    log(`done: ${ok}/${jobs.length} ok`);
    if (failed.length) {
      for (const item of failed) log(`  - ${item}`);
      process.exitCode = 1;
    }
  }

  if (values.all || values.layer) {
    if (values.all && values.layer) throw new Error("--all and --layer cannot be combined");
    if (positionals.length || values.output || values.report || values.name) {
      throw new Error("--all/--layer cannot be combined with dem, adcode, --output, --report, or --name");
    }
    const layers = values.all ? ["state", "province"] : [values.layer];
    const jobs = layers.flatMap((layer) => jobsForLayer(layer, values.parent));
    await renderJobs(jobs);
    return;
  }

  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error(
      "Usage: node src/render.js <dem-prefix> <adcode> | node src/render.js <adcode> | node src/render.js --layer state|province|city|district [--parent 320000]",
    );
  }
  const adcode = positionals[positionals.length - 1];
  const demName = positionals.length === 2 ? positionals[0] : null;
  const job = findJob(adcode);
  if (!job) throw new Error(`GeoJSON feature not found for ${adcode}`);
  await renderJob(job, {
    demName,
    output: values.output,
    report: values.report,
    name: values.name,
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
