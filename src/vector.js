import fs from "node:fs";

function walkCoordinates(value, visit) {
  if (!Array.isArray(value) || value.length === 0) return;
  if (typeof value[0] === "number") {
    visit(value[0], value[1]);
    return;
  }
  for (const child of value) walkCoordinates(child, visit);
}

export function loadGeojson(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  let features;
  if (data.type === "FeatureCollection") features = data.features || [];
  else if (data.type === "Feature") features = [data];
  else if (data.type === "Polygon" || data.type === "MultiPolygon") {
    features = [{ type: "Feature", properties: {}, geometry: data }];
  } else {
    throw new Error(`Unsupported GeoJSON root type: ${data.type}`);
  }
  if (!features.length) throw new Error("GeoJSON contains no features");
  features.forEach((feature, index) => {
    const geometryType = feature.geometry?.type;
    if (geometryType !== "Polygon" && geometryType !== "MultiPolygon") {
      throw new Error(`Feature ${index} has unsupported geometry type: ${geometryType}`);
    }
  });
  return { type: "FeatureCollection", features };
}

export function polygons(data) {
  const result = [];
  for (const feature of data.features) {
    const geometry = feature.geometry;
    if (geometry.type === "Polygon") result.push(geometry.coordinates);
    else result.push(...geometry.coordinates);
  }
  return result;
}

export function boundsOf(data) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const polygon of polygons(data)) {
    walkCoordinates(polygon, (lon, lat) => {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    });
  }
  return { west, east, south, north };
}

function fillRing(buffer, width, height, ring, color) {
  const edges = [];
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (current[0] === next[0] && current[1] === next[1]) continue;
    let x0 = current[0];
    let y0 = current[1];
    let x1 = next[0];
    let y1 = next[1];
    if (y0 === y1) continue;
    if (y0 > y1) {
      [x0, x1] = [x1, x0];
      [y0, y1] = [y1, y0];
    }
    edges.push({ y0, y1, x: x0, dx: (x1 - x0) / (y1 - y0) });
  }
  if (!edges.length) return;
  let edgeMin = Infinity;
  let edgeMax = -Infinity;
  for (const edge of edges) {
    if (edge.y0 < edgeMin) edgeMin = edge.y0;
    if (edge.y1 > edgeMax) edgeMax = edge.y1;
  }
  const yStart = Math.max(0, Math.floor(edgeMin));
  const yEnd = Math.min(height - 1, Math.ceil(edgeMax) - 1);
  for (let y = yStart; y <= yEnd; y += 1) {
    const scan = y + 0.5;
    const crossings = [];
    for (const edge of edges) {
      if (scan >= edge.y0 && scan < edge.y1) {
        crossings.push(edge.x + (scan - edge.y0) * edge.dx);
      }
    }
    crossings.sort((a, b) => a - b);
    const row = y * width;
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      let x0 = Math.ceil(crossings[pair]);
      let x1 = Math.floor(crossings[pair + 1]);
      if (x1 < 0 || x0 >= width) continue;
      x0 = Math.max(0, x0);
      x1 = Math.min(width - 1, x1);
      for (let x = x0; x <= x1; x += 1) buffer[row + x] = color;
    }
  }
}

function projectRing(ring, frame, width, height) {
  const spanX = frame.east - frame.west || 1;
  const spanY = frame.north - frame.south || 1;
  return ring.map(([lon, lat]) => [
    Math.round(((lon - frame.west) / spanX) * (width - 1)),
    Math.round(((frame.north - lat) / spanY) * (height - 1)),
  ]);
}

export function rasterizeProjected(projectedShapes, width, height) {
  const mask = new Uint8Array(width * height);
  for (const projected of projectedShapes) {
    if (!projected.length || projected[0].length < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of projected) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    maxX = Math.min(width - 1, maxX);
    maxY = Math.min(height - 1, maxY);
    if (maxX < minX || maxY < minY) continue;
    const localWidth = maxX - minX + 1;
    const localHeight = maxY - minY + 1;
    const local = new Uint8Array(localWidth * localHeight);
    const shifted = projected.map((ring) => ring.map(([x, y]) => [x - minX, y - minY]));
    fillRing(local, localWidth, localHeight, shifted[0], 255);
    for (const hole of shifted.slice(1)) fillRing(local, localWidth, localHeight, hole, 0);
    for (let y = 0; y < localHeight; y += 1) {
      const source = y * localWidth;
      const target = (y + minY) * width + minX;
      for (let x = 0; x < localWidth; x += 1) {
        if (local[source + x] > mask[target + x]) mask[target + x] = local[source + x];
      }
    }
  }
    return mask;
}

export function rasterizePolygons(shapes, frame, width, height) {
  return rasterizeProjected(
    shapes.map((rings) => rings.map((ring) => projectRing(ring, frame, width, height))),
    width,
    height,
  );
}

function signedArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area * 0.5;
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  let previous = ring[ring.length - 1];
  for (const current of ring) {
    if ((current[1] > y) !== (previous[1] > y)) {
      const intersect =
        ((previous[0] - current[0]) * (y - current[1])) / (previous[1] - current[1]) +
        current[0];
      if (x < intersect) inside = !inside;
    }
    previous = current;
  }
  return inside;
}

function polygonsFromRings(rings) {
  if (!rings.length) return [];
  let exteriors = rings.filter((ring) => signedArea(ring) < 0);
  let holes = rings.filter((ring) => signedArea(ring) >= 0);
  if (!exteriors.length) {
    let largest = rings[0];
    let largestArea = Math.abs(signedArea(largest));
    for (const ring of rings) {
      const area = Math.abs(signedArea(ring));
      if (area > largestArea) {
        largest = ring;
        largestArea = area;
      }
    }
    exteriors = [largest];
    holes = rings.filter((ring) => ring !== largest);
  }
  const assigned = exteriors.map(() => []);
  for (const hole of holes) {
    if (!hole.length) continue;
    let chosen = -1;
    let chosenArea = Infinity;
    exteriors.forEach((exterior, index) => {
      const area = Math.abs(signedArea(exterior));
      if (pointInRing(hole[0], exterior) && area < chosenArea) {
        chosen = index;
        chosenArea = area;
      }
    });
    if (chosen >= 0) assigned[chosen].push(hole);
  }
  const shapes = [];
  exteriors.forEach((exterior, index) => {
    if (exterior.length < 3) return;
    shapes.push([
      exterior.map((point) => [point[0], point[1]]),
      ...assigned[index]
        .filter((hole) => hole.length >= 3)
        .map((hole) => hole.map((point) => [point[0], point[1]])),
    ]);
  });
  return shapes;
}

export function readShapefilePolygons(filePath, bounds) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 100 || buffer.readInt32BE(0) !== 9994) {
    throw new Error(`Invalid Shapefile: ${filePath}`);
  }
  const shapes = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLength = buffer.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const end = start + contentLength;
    if (end > buffer.length) break;
    offset = end;
    const record = buffer.subarray(start, end);
    if (record.readInt32LE(0) !== 5) continue;
    const xmin = record.readDoubleLE(4);
    const ymin = record.readDoubleLE(12);
    const xmax = record.readDoubleLE(20);
    const ymax = record.readDoubleLE(28);
    if (
      bounds &&
      (xmax < bounds.west || xmin > bounds.east || ymax < bounds.south || ymin > bounds.north)
    ) {
      continue;
    }
    const partCount = record.readInt32LE(36);
    const pointCount = record.readInt32LE(40);
    const starts = [];
    for (let index = 0; index < partCount; index += 1) {
      starts.push(record.readInt32LE(44 + index * 4));
    }
    starts.push(pointCount);
    const pointsOffset = 44 + partCount * 4;
    const rings = [];
    for (let part = 0; part < partCount; part += 1) {
      const ring = [];
      for (let point = starts[part]; point < starts[part + 1]; point += 1) {
        const pointOffset = pointsOffset + point * 16;
        ring.push([record.readDoubleLE(pointOffset), record.readDoubleLE(pointOffset + 8)]);
      }
      rings.push(ring);
    }
    shapes.push(...polygonsFromRings(rings));
  }
  return shapes;
}
