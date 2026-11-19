import { DEFAULT_CANVAS, DEFAULT_MAX_PLACED } from "./params.js";
import { polygons } from "./vector.js";

export function windowFrame(dem, bounds) {
  const overlapWest = Math.max(dem.west, bounds.west);
  const overlapEast = Math.min(dem.east, bounds.east);
  const overlapSouth = Math.max(dem.south, bounds.south);
  const overlapNorth = Math.min(dem.north, bounds.north);
  if (overlapWest >= overlapEast || overlapSouth >= overlapNorth) return null;
  const scaleX = (dem.east - dem.west) / dem.width;
  const scaleY = (dem.north - dem.south) / dem.height;
  const col0 = Math.max(0, Math.min(dem.width - 1, Math.floor((overlapWest - dem.west) / scaleX)));
  const col1 = Math.max(col0 + 1, Math.min(dem.width, Math.ceil((overlapEast - dem.west) / scaleX)));
  const row0 = Math.max(0, Math.min(dem.height - 1, Math.floor((dem.north - overlapNorth) / scaleY)));
  const row1 = Math.max(row0 + 1, Math.min(dem.height, Math.ceil((dem.north - overlapSouth) / scaleY)));
  return {
    col0,
    row0,
    col1,
    row1,
    west: dem.west + col0 * scaleX,
    east: dem.west + col1 * scaleX,
    north: dem.north - row0 * scaleY,
    south: dem.north - row1 * scaleY,
    sourceWidth: col1 - col0,
    sourceHeight: row1 - row0,
  };
}

export function gridSize(sourceWidth, sourceHeight, maxWorkWidth) {
  const gridWidth = Math.max(1, Math.min(maxWorkWidth, sourceWidth));
  const workHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * gridWidth));
  return { gridWidth, workHeight };
}

export function cropBox(data, frame, gridWidth, workHeight) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons(data)) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        const x = ((lon - frame.west) / (frame.east - frame.west)) * (gridWidth - 1);
        const y = ((frame.north - lat) / (frame.north - frame.south)) * (workHeight - 1);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return [
    Math.max(0, Math.floor(minX) - 6),
    Math.max(0, Math.floor(minY) - 6),
    Math.min(gridWidth, Math.ceil(maxX) + 1 + 6),
    Math.min(workHeight, Math.ceil(maxY) + 1 + 6),
  ];
}

export function placement(cropWidth, cropHeight, canvasWidth, canvasHeight, aspectScale) {
  const maxPlacedWidth = Math.round((canvasWidth * DEFAULT_MAX_PLACED[0]) / DEFAULT_CANVAS[0]);
  const maxPlacedHeight = Math.round((canvasHeight * DEFAULT_MAX_PLACED[1]) / DEFAULT_CANVAS[1]);
  const displayWidth = cropWidth * aspectScale;
  const fit = Math.min(maxPlacedWidth / displayWidth, maxPlacedHeight / cropHeight);
  const placedWidth = Math.round(displayWidth * fit);
  const placedHeight = Math.round(cropHeight * fit);
  return {
    placedWidth,
    placedHeight,
    originX: Math.floor((canvasWidth - placedWidth) / 2),
    originY: Math.floor((canvasHeight - placedHeight) / 2),
  };
}
