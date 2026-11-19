import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import { findJob, jobsForLayer } from "./catalog.js";
import { CLASS_RGB, clcdPath, MATERIAL_BASE, MATERIAL_BASE_CODES, openClcd, sampleClasses } from "./clcd.js";
import { openDem, readTiledNearest } from "./dem.js";
import { boxMean, castShadowFactor, hillshade, maskedBoxMean, resizeGray } from "./image.js";
import { cropBox, gridSize, placement, windowFrame } from "./layout.js";
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
  SHADE_BASE_WEIGHT,
  SHADE_RELIEF_WEIGHT,
  SLOPE_REF,
  TERRAIN_BASE_GRAY,
  TONE_GRAY_FLOOR,
  TONE_GRAY_MAX,
} from "./params.js";
import { polygons, rasterizePolygons, rasterizeProjected } from "./vector.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.resolve(
  process.env.TERRAIN_RESOURCES || path.join(repoDir, "..", "province-terrain-resources"),
);

const CLASS_FILES = {
  1: ["cropland", "耕地"],
  2: ["forest", "林地"],
  3: ["shrub", "灌木"],
  4: ["grass", "草地"],
  5: ["water", "水体"],
  6: ["snow", "冰雪"],
  7: ["barren", "裸地"],
  8: ["impervious", "建成区"],
  9: ["wetland", "湿地"],
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

function pinyinStem(adcode, dem) {
  const code = codeOf(adcode);
  if (ADCODE_PINYIN[code]) return ADCODE_PINYIN[code];
  const cleaned = String(dem || code).replace(/[^A-Za-z0-9_-]+/g, "");
  return cleaned || code;
}

function demDirectory(resolution) {
  if (resolution === 30) return path.join(resourcesDir, "DEM");
  if (resolution === 200) return path.join(resourcesDir, "DEM_200");
  throw new Error("Unsupported DEM resolution; expected 30 or 200");
}

function resolveDem(directory, name) {
  if (!fs.existsSync(directory)) throw new Error(`DEM directory not found: ${directory}`);
  const token = name.toLowerCase();
  const exact = [];
  for (const file of fs.readdirSync(directory)) {
    if (![".tif", ".tiff", ".TIF", ".TIFF"].includes(path.extname(file))) continue;
    const stem = path.basename(file, path.extname(file)).toLowerCase();
    if (stem.split("_")[0] === token) exact.push(path.join(directory, file));
  }
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`DEM name ${name} is ambiguous`);
  throw new Error(`DEM not found: ${name}`);
}

function coordinateBounds(data) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const polygon of polygons(data)) {
    for (const ring of polygon) {
      for (const point of ring) {
        west = Math.min(west, point[0]);
        east = Math.max(east, point[0]);
        south = Math.min(south, point[1]);
        north = Math.max(north, point[1]);
      }
    }
  }
  return { west, east, south, north };
}

function resizeCovered(rgb, coverage, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const count = sourceWidth * sourceHeight;
  const alpha = new Float32Array(count);
  const planes = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  for (let index = 0; index < count; index += 1) {
    const weight = coverage[index] / 255;
    alpha[index] = weight;
    planes[0][index] = rgb[index * 3] * weight;
    planes[1][index] = rgb[index * 3 + 1] * weight;
    planes[2][index] = rgb[index * 3 + 2] * weight;
  }
  const resizedAlpha = resizeGray(alpha, sourceWidth, sourceHeight, targetWidth, targetHeight);
  const resizedPlanes = planes.map((plane) =>
    resizeGray(plane, sourceWidth, sourceHeight, targetWidth, targetHeight),
  );
  const color = new Uint8Array(targetWidth * targetHeight * 3);
  const mask = new Uint8Array(targetWidth * targetHeight);
  for (let index = 0; index < mask.length; index += 1) {
    if (resizedAlpha[index] < 0.5) continue;
    mask[index] = 255;
    const scale = 1 / resizedAlpha[index];
    color[index * 3] = clip(Math.round(resizedPlanes[0][index] * scale), 0, 255);
    color[index * 3 + 1] = clip(Math.round(resizedPlanes[1][index] * scale), 0, 255);
    color[index * 3 + 2] = clip(Math.round(resizedPlanes[2][index] * scale), 0, 255);
  }
  return { color, mask };
}

function vectorAlpha(data, frame, gridWidth, workHeight, crop, place, canvasWidth, canvasHeight, supersample) {
  const cropWidth = crop[2] - crop[0];
  const cropHeight = crop[3] - crop[1];
  const projected = polygons(data).map((rings) =>
    rings.map((ring) =>
      ring.map(([lon, lat]) => {
        const workX = ((lon - frame.west) / (frame.east - frame.west)) * (gridWidth - 1);
        const workY = ((frame.north - lat) / (frame.north - frame.south)) * (workHeight - 1);
        const x = place.originX + ((workX - crop[0]) * place.placedWidth) / cropWidth;
        const y = place.originY + ((workY - crop[1]) * place.placedHeight) / cropHeight;
        return [Math.round(x * supersample), Math.round(y * supersample)];
      }),
    ),
  );
  const highMask = rasterizeProjected(
    projected,
    canvasWidth * supersample,
    canvasHeight * supersample,
  );
  return resizeGray(highMask, canvasWidth * supersample, canvasHeight * supersample, canvasWidth, canvasHeight);
}

function paintPlaced(rgb, coverage, cropWidth, cropHeight, place, alpha, canvasWidth, canvasHeight) {
  const covered = resizeCovered(rgb, coverage, cropWidth, cropHeight, place.placedWidth, place.placedHeight);
  const canvas = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  for (let y = 0; y < place.placedHeight; y += 1) {
    for (let x = 0; x < place.placedWidth; x += 1) {
      const source = y * place.placedWidth + x;
      if (!covered.mask[source]) continue;
      const canvasIndex = (y + place.originY) * canvasWidth + (x + place.originX);
      const target = canvasIndex * 4;
      canvas[target] = covered.color[source * 3];
      canvas[target + 1] = covered.color[source * 3 + 1];
      canvas[target + 2] = covered.color[source * 3 + 2];
      canvas[target + 3] = clip(Math.round((alpha[canvasIndex] * covered.mask[source]) / 255), 0, 255);
    }
  }
  for (let index = 0; index < canvas.length; index += 4) {
    if (canvas[index + 3] !== 0) continue;
    canvas[index] = 0;
    canvas[index + 1] = 0;
    canvas[index + 2] = 0;
  }
  return canvas;
}

function colorize(classes, colorOf) {
  const rgb = new Uint8Array(classes.length * 3);
  const coverage = new Uint8Array(classes.length);
  let pixels = 0;
  for (let index = 0; index < classes.length; index += 1) {
    const color = colorOf(classes[index]);
    if (!color) continue;
    coverage[index] = 255;
    rgb[index * 3] = color[0];
    rgb[index * 3 + 1] = color[1];
    rgb[index * 3 + 2] = color[2];
    pixels += 1;
  }
  return { rgb, coverage, pixels };
}

function writeCanvas(canvas, filePath, width, height) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });
  png.data.set(canvas);
  fs.writeFileSync(filePath, PNG.sync.write(png));
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
  const fine = hillshade(terrain, halo, width, height, cellX, cellY, shadeOptions(HILLSHADE_FINE_EXAGGERATION));
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
      0.5 + (combined[i] - 0.5) * HILLSHADE_CONTRAST + (combined[i] - neighborhood[i]) * HILLSHADE_DETAIL,
      0,
      1,
    );
  }
  return sharpened;
}

async function terrainGray(dem, frame, gridWidth, workHeight, data) {
  const sampled = await readTiledNearest(
    dem,
    gridWidth,
    workHeight,
    (percent) => log(`dem_read=${percent}%`),
    frame,
  );
  const admin = rasterizePolygons(polygons(data), frame, gridWidth, workHeight);
  const valid = new Uint8Array(sampled.length);
  for (let i = 0; i < sampled.length; i += 1) {
    if (sampled[i] !== dem.nodata && admin[i]) valid[i] = 1;
  }
  const gray = new Float32Array(sampled.length);
  gray.fill(TERRAIN_BASE_GRAY);
  if (!valid.some((value) => value)) return gray;
  const { terrain, halo } = prepareTerrain(sampled, valid, gridWidth, workHeight);
  const latitude = (frame.north + frame.south) / 2;
  const cellX =
    ((frame.east - frame.west) * 111320 * Math.cos((latitude * Math.PI) / 180)) / Math.max(gridWidth, 1);
  const cellY = ((frame.north - frame.south) * 111320) / Math.max(workHeight, 1);
  log(`shade cells≈${cellX.toFixed(1)}m x ${cellY.toFixed(1)}m`);
  const localShade = multiscaleShade(terrain, halo, gridWidth, workHeight, cellX, cellY);
  let castFactor = new Float32Array(sampled.length);
  castFactor.fill(1);
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
    log(`cast_shadow done (shadowPixels=${cast.shadowPixels})`);
  }
  const linear = new Float32Array(sampled.length);
  for (let i = 0; i < linear.length; i += 1) {
    const shade = clip(localShade[i] * castFactor[i], 0, 1);
    linear[i] = clip(
      TERRAIN_BASE_GRAY * (SHADE_BASE_WEIGHT + SHADE_RELIEF_WEIGHT * shade),
      TONE_GRAY_FLOOR,
      TONE_GRAY_MAX,
    );
  }
  const neighborhood = boxMean(linear, gridWidth, workHeight, 1);
  for (let i = 0; i < gray.length; i += 1) {
    if (!valid[i]) continue;
    gray[i] = clip(
      Math.trunc(linear[i] + (linear[i] - neighborhood[i]) * GRAY_UNSHARP_AMOUNT),
      TONE_GRAY_FLOOR,
      TONE_GRAY_MAX,
    );
  }
  return gray;
}

function colorizeShaded(classes, crop, gridWidth, gray) {
  const cropWidth = crop[2] - crop[0];
  const rgb = new Uint8Array(classes.length * 3);
  const coverage = new Uint8Array(classes.length);
  for (let index = 0; index < classes.length; index += 1) {
    const color = MATERIAL_BASE_CODES.has(classes[index]) ? MATERIAL_BASE : CLASS_RGB[classes[index]];
    if (!color) continue;
    const shade = gray[(Math.floor(index / cropWidth) + crop[1]) * gridWidth + ((index % cropWidth) + crop[0])] / TERRAIN_BASE_GRAY;
    coverage[index] = 255;
    rgb[index * 3] = clip(Math.round(color[0] * shade), 0, 255);
    rgb[index * 3 + 1] = clip(Math.round(color[1] * shade), 0, 255);
    rgb[index * 3 + 2] = clip(Math.round(color[2] * shade), 0, 255);
  }
  return { rgb, coverage };
}

async function renderMaterial(job, options) {
  const clcdFile = clcdPath(resourcesDir, job.demAdcode);
  if (!clcdFile) throw new Error(`No CLCD raster for ${job.name} (${job.demAdcode})`);
  const demPath = resolveDem(options.demDirectory, job.demPrefix);
  const data = { type: "FeatureCollection", features: [job.feature] };
  const dem = await openDem(demPath);
  const frame = windowFrame(dem, coordinateBounds(data));
  if (!frame) throw new Error(`${job.name} does not overlap ${path.basename(demPath)}`);
  const { gridWidth, workHeight } = gridSize(frame.sourceWidth, frame.sourceHeight, options.workWidth);
  const crop = cropBox(data, frame, gridWidth, workHeight);
  const cropWidth = crop[2] - crop[0];
  const cropHeight = crop[3] - crop[1];
  log(`clcd ${path.basename(clcdFile)} window ${frame.sourceWidth}x${frame.sourceHeight} -> ${gridWidth}x${workHeight}`);
  const clcd = await openClcd(clcdFile);
  const classes = await sampleClasses(clcd, frame, gridWidth, workHeight, crop);
  const place = placement(cropWidth, cropHeight, options.canvasWidth, options.canvasHeight, options.aspectScale);
  log(`place ${cropWidth}x${cropHeight} -> ${place.placedWidth}x${place.placedHeight}`);
  const alpha = vectorAlpha(
    data,
    frame,
    gridWidth,
    workHeight,
    crop,
    place,
    options.canvasWidth,
    options.canvasHeight,
    options.supersample,
  );
  const paint = (colorOf) => {
    const colored = colorize(classes, colorOf);
    return {
      pixels: colored.pixels,
      canvas: paintPlaced(
        colored.rgb,
        colored.coverage,
        cropWidth,
        cropHeight,
        place,
        alpha,
        options.canvasWidth,
        options.canvasHeight,
      ),
    };
  };

  for (const code of Object.keys(CLASS_FILES)) {
    const [file, label] = CLASS_FILES[code];
    const plate = paint((value) => (value === Number(code) ? CLASS_RGB[code] : null));
    const filePath = path.join(options.classDir, `${file}.png`);
    writeCanvas(plate.canvas, filePath, options.canvasWidth, options.canvasHeight);
    log(`${label} ${plate.pixels} px  ${filePath}`);
  }

  const combined = paint((code) => (MATERIAL_BASE_CODES.has(code) ? MATERIAL_BASE : CLASS_RGB[code]));
  writeCanvas(combined.canvas, options.combinedPath, options.canvasWidth, options.canvasHeight);
  log(options.combinedPath);

  const gray = await terrainGray(dem, frame, gridWidth, workHeight, data);
  const shaded = colorizeShaded(classes, crop, gridWidth, gray);
  const shadedCanvas = paintPlaced(
    shaded.rgb,
    shaded.coverage,
    cropWidth,
    cropHeight,
    place,
    alpha,
    options.canvasWidth,
    options.canvasHeight,
  );
  writeCanvas(shadedCanvas, options.shadedPath, options.canvasWidth, options.canvasHeight);
  log(options.shadedPath);
}

function sampleCenterBounds(dem) {
  const pixelWidth = (dem.east - dem.west) / dem.width;
  const pixelHeight = (dem.north - dem.south) / dem.height;
  return {
    west: dem.west + pixelWidth / 2,
    south: dem.south + pixelHeight / 2,
    east: dem.east - pixelWidth / 2,
    north: dem.north - pixelHeight / 2,
  };
}

function albedoSize(demWidth, demHeight, maxWorkWidth) {
  const scale = Math.max(1, Math.floor(Number(maxWorkWidth) / demWidth) || 1);
  return { width: demWidth * scale, height: demHeight * scale, scale };
}

function albedoPaths(job, root, explicitFile) {
  const pngPath = explicitFile || outputPathFor(job, root);
  return {
    pngPath,
    sidecarPath: `${pngPath.replace(/\.png$/i, "")}.json`,
  };
}

async function renderAlbedo(job, options) {
  const clcdFile = clcdPath(resourcesDir, job.demAdcode);
  if (!clcdFile) throw new Error(`No CLCD raster for ${job.name} (${job.demAdcode})`);
  const dem = await openDem(options.alignDemPath);
  const frame = sampleCenterBounds(dem);
  const { width, height, scale } = albedoSize(dem.width, dem.height, options.workWidth);
  const crop = [0, 0, width, height];
  const data = { type: "FeatureCollection", features: [job.feature] };
  log(
    `albedo align ${path.basename(options.alignDemPath)} ${dem.width}x${dem.height} x${scale} -> ${width}x${height}`,
  );
  const clcd = await openClcd(clcdFile);
  log(`clcd ${path.basename(clcdFile)}`);
  const classes = await sampleClasses(clcd, frame, width, height, crop);
  const colored = colorize(classes, (code) =>
    MATERIAL_BASE_CODES.has(code) ? MATERIAL_BASE : CLASS_RGB[code],
  );
  const maxHigh = 8192;
  const supersample = Math.max(
    1,
    Math.min(options.supersample, Math.floor(maxHigh / Math.max(width, height)) || 1),
  );
  let alpha;
  if (supersample > 1) {
    log(`vector_alpha ${width * supersample}x${height * supersample}`);
    const highMask = rasterizePolygons(
      polygons(data),
      frame,
      width * supersample,
      height * supersample,
    );
    alpha = resizeGray(highMask, width * supersample, height * supersample, width, height);
  } else {
    alpha = rasterizePolygons(polygons(data), frame, width, height);
  }
  const canvas = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < classes.length; index += 1) {
    const offset = index * 4;
    const opacity = colored.coverage[index]
      ? clip(Math.round(alpha[index]), 0, 255)
      : 0;
    if (opacity === 0) continue;
    canvas[offset] = colored.rgb[index * 3];
    canvas[offset + 1] = colored.rgb[index * 3 + 1];
    canvas[offset + 2] = colored.rgb[index * 3 + 2];
    canvas[offset + 3] = opacity;
  }
  writeCanvas(canvas, options.pngPath, width, height);
  const sidecar = {
    image: path.basename(options.pngPath),
    width,
    height,
    crs: "EPSG:4326",
    bounds: [frame.west, frame.south, frame.east, frame.north],
    uv: {
      u: "west-to-east",
      v: "south-to-north",
    },
    flipY: true,
    alignedDem: path.basename(options.alignDemPath),
    alignedDemPath: path.resolve(options.alignDemPath),
    alignedDemSize: [dem.width, dem.height],
    gridScale: scale,
    shading: "none",
  };
  fs.mkdirSync(path.dirname(options.sidecarPath), { recursive: true });
  fs.writeFileSync(options.sidecarPath, `${JSON.stringify(sidecar, null, 4)}\n`);
  log(options.pngPath);
  log(options.sidecarPath);
  return sidecar;
}

async function runAlignedMaterial(values, positionals) {
  if (values.all || values.layer) {
    throw new Error("--align-dem currently supports a single adcode, not --all/--layer");
  }
  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error(
      "Usage: node src/material.js <adcode> --align-dem <dem.tif> | node src/material.js <dem-prefix> <adcode> --align-dem <dem.tif>",
    );
  }
  const adcode = positionals[positionals.length - 1];
  const job = findJob(adcode);
  if (!job) throw new Error(`GeoJSON feature not found for ${adcode}`);
  if (positionals.length === 2 && positionals[0].toLowerCase() !== String(job.demPrefix).toLowerCase()) {
    throw new Error(`${job.name} uses DEM ${job.demPrefix}, got ${positionals[0]}`);
  }
  const alignDemPath = path.resolve(values["align-dem"]);
  if (!fs.existsSync(alignDemPath)) throw new Error(`Align DEM not found: ${alignDemPath}`);
  const paths = albedoPaths(
    job,
    path.join(resourcesDir, "outputs", "albedo"),
    values.output,
  );
  log(`${job.layer} ${job.name} (${job.adcode}) albedo ← ${path.basename(alignDemPath)}`);
  await renderAlbedo(job, {
    alignDemPath,
    workWidth: Number(values["work-width"]),
    supersample: Number(values.supersample),
    ...paths,
  });
}

function parseCanvas(value) {
  const match = String(value).match(/^(\d+)[xX,](\d+)$/);
  if (!match) throw new Error(`Invalid canvas size: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function outputStem(job) {
  const nested = job.layer === "city" || job.layer === "district";
  return { nested, stem: nested ? job.adcode : pinyinStem(job.adcode, job.demPrefix) };
}

function outputPathFor(job, root) {
  const { nested, stem } = outputStem(job);
  return path.join(root, nested ? job.layer : "", `${stem}.png`);
}

function outputSet(job, root, explicitFile) {
  const combinedPath = explicitFile || outputPathFor(job, root);
  const stem = path.basename(combinedPath, path.extname(combinedPath));
  const dir = path.dirname(combinedPath);
  return {
    combinedPath,
    classDir: path.join(dir, stem),
    shadedPath: path.join(dir, `${stem}-shaded.png`),
  };
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
      canvas: { type: "string", default: `${DEFAULT_CANVAS[0]}x${DEFAULT_CANVAS[1]}` },
      "work-width": { type: "string", default: String(DEFAULT_WORK_WIDTH) },
      supersample: { type: "string", default: String(DEFAULT_SUPERSAMPLE) },
      "aspect-scale": { type: "string", default: String(DEFAULT_ASPECT_SCALE) },
      "continue-on-error": { type: "boolean", default: false },
      "align-dem": { type: "string" },
    },
  });
  if (values["align-dem"]) {
    await runAlignedMaterial(values, positionals);
    return;
  }
  const resolution = Number(values["dem-res"]);
  const directory = demDirectory(resolution);
  if (!fs.existsSync(directory)) throw new Error(`DEM directory for ${resolution} m not found: ${directory}`);
  const [canvasWidth, canvasHeight] = parseCanvas(values.canvas);
  const materialsDir = path.join(resourcesDir, "outputs", resolution === 200 ? "materials_200" : "materials");
  const shared = {
    demDirectory: directory,
    canvasWidth,
    canvasHeight,
    workWidth: Number(values["work-width"]),
    supersample: Number(values.supersample),
    aspectScale: Number(values["aspect-scale"]),
  };

  async function runJob(job, paths, label) {
    const source = path.basename(clcdPath(resourcesDir, job.demAdcode) || "missing");
    log(`${label || ""}${job.layer} ${job.name} (${job.adcode}) ← ${source}`);
    await renderMaterial(job, { ...shared, ...paths });
  }

  if (values.all || values.layer) {
    if (values.all && values.layer) throw new Error("--all and --layer cannot be combined");
    if (positionals.length || values.output) {
      throw new Error("--all/--layer cannot be combined with an adcode or --output");
    }
    const jobs = (values.all ? ["state", "province"] : [values.layer]).flatMap((layer) =>
      jobsForLayer(layer, values.parent),
    );
    let ok = 0;
    let skipped = 0;
    const failed = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      if (!clcdPath(resourcesDir, job.demAdcode)) {
        log(`[${index + 1}/${jobs.length}] skip ${job.name} (${job.adcode}): no CLCD`);
        skipped += 1;
        continue;
      }
      try {
        await runJob(job, outputSet(job, materialsDir), `[${index + 1}/${jobs.length}] `);
        ok += 1;
      } catch (error) {
        failed.push(`${job.adcode}: ${error.message}`);
        log(`  !! ${error.message}`);
        if (!values["continue-on-error"]) throw error;
      }
    }
    log(`done: ${ok} written, ${skipped} skipped, ${failed.length} failed`);
    if (failed.length) process.exitCode = 1;
    return;
  }

  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error(
      "Usage: node src/material.js <dem-prefix> <adcode> | node src/material.js <adcode> | node src/material.js --layer city --parent 320000",
    );
  }
  const adcode = positionals[positionals.length - 1];
  const job = findJob(adcode);
  if (!job) throw new Error(`GeoJSON feature not found for ${adcode}`);
  if (positionals.length === 2 && positionals[0].toLowerCase() !== String(job.demPrefix).toLowerCase()) {
    throw new Error(`${job.name} uses DEM ${job.demPrefix}, got ${positionals[0]}`);
  }
  await runJob(job, outputSet(job, materialsDir, values.output));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
