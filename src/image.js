export function boxMean(values, width, height, radius) {
  const kernel = radius * 2 + 1;
  const paddedWidth = width + radius * 2;
  const paddedHeight = height + radius * 2;
  const stride = paddedWidth + 1;
  const integral = new Float64Array((paddedHeight + 1) * stride);
  for (let y = 0; y < paddedHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, y - radius));
    const sourceRow = sourceY * width;
    let rowSum = 0;
    const integralRow = (y + 1) * stride;
    const previousRow = y * stride;
    for (let x = 0; x < paddedWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, x - radius));
      rowSum += values[sourceRow + sourceX];
      integral[integralRow + x + 1] = integral[previousRow + x + 1] + rowSum;
    }
  }
  const out = new Float32Array(width * height);
  const area = kernel * kernel;
  for (let y = 0; y < height; y += 1) {
    const y1 = y + kernel;
    for (let x = 0; x < width; x += 1) {
      const x1 = x + kernel;
      const sum =
        integral[y1 * stride + x1] -
        integral[y * stride + x1] -
        integral[y1 * stride + x] +
        integral[y * stride + x];
      out[y * width + x] = sum / area;
    }
  }
  return out;
}

export function maskedBoxMean(values, valid, width, height, radius) {
  const count = width * height;
  const numerator = new Float32Array(count);
  const weights = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    if (valid[i]) {
      numerator[i] = values[i];
      weights[i] = 1;
    }
  }
  const numerMean = boxMean(numerator, width, height, radius);
  const weightMean = boxMean(weights, width, height, radius);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = weightMean[i] > 1e-4 ? numerMean[i] / Math.max(weightMean[i], 1e-4) : Number.NaN;
  }
  return out;
}

function gradient(values, width, height, spacingY, spacingX) {
  const gy = new Float32Array(values.length);
  const gx = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const y0 = y === 0 ? 0 : y - 1;
    const y1 = y === height - 1 ? height - 1 : y + 1;
    const divisor = (y === 0 || y === height - 1 ? 1 : 2) * spacingY;
    const row0 = y0 * width;
    const row1 = y1 * width;
    for (let x = 0; x < width; x += 1) {
      gy[row + x] = (values[row1 + x] - values[row0 + x]) / divisor;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const x0 = x === 0 ? 0 : x - 1;
      const x1 = x === width - 1 ? width - 1 : x + 1;
      const divisor = (x === 0 || x === width - 1 ? 1 : 2) * spacingX;
      gx[row + x] = (values[row + x1] - values[row + x0]) / divisor;
    }
  }
  return { gx, gy };
}

export function hillshade(terrain, valid, width, height, cellX, cellY, options) {
  const {
    azimuth,
    altitude,
    exaggeration,
    flatShade,
    slopeRef,
    flatGamma,
  } = options;
  const filled = new Float32Array(terrain.length);
  for (let i = 0; i < terrain.length; i += 1) {
    filled[i] = Number.isFinite(terrain[i]) ? terrain[i] * exaggeration : 0;
  }
  const { gx, gy } = gradient(filled, width, height, cellY, cellX);
  const shade = new Float32Array(terrain.length);
  const azimuthRad = (azimuth * Math.PI) / 180;
  const altitudeRad = (altitude * Math.PI) / 180;
  const cosAlt = Math.cos(altitudeRad);
  const sinAlt = Math.sin(altitudeRad);
  const slopeLimit = Math.max(slopeRef, 1e-6);
  for (let i = 0; i < terrain.length; i += 1) {
    if (!valid[i]) {
      shade[i] = 1;
      continue;
    }
    const slope = Math.atan(Math.hypot(gx[i], gy[i]));
    const aspect = Math.atan2(-gx[i], gy[i]);
    let value =
      cosAlt * Math.cos(slope) +
      sinAlt * Math.sin(slope) * Math.cos(azimuthRad - aspect);
    value = Math.min(1, Math.max(0, (value + 0.15) / 1.15));
    let slopeWeight = Math.min(1, Math.max(0, slope / slopeLimit));
    if (flatGamma !== 1) slopeWeight **= flatGamma;
    value = flatShade + (value - flatShade) * slopeWeight;
    shade[i] = Math.min(1, Math.max(0, value));
  }
  return shade;
}

export function castShadowFactor(terrain, valid, width, height, cellX, cellY, options, onProgress) {
  const { azimuth, altitude, maxDist, stepPx, zExag, heightBias, castShade } = options;
  const factor = new Float32Array(terrain.length);
  factor.fill(1);
  const filled = new Float32Array(terrain.length);
  for (let i = 0; i < terrain.length; i += 1) {
    filled[i] = Number.isFinite(terrain[i]) ? terrain[i] * zExag : -1e9;
  }
  const azimuthRad = (azimuth * Math.PI) / 180;
  const altitudeRad = (altitude * Math.PI) / 180;
  const directionX = Math.sin(azimuthRad);
  const directionY = -Math.cos(azimuthRad);
  const length = Math.hypot(directionX, directionY) || 1;
  const stepX = (directionX / length) * stepPx;
  const stepY = (directionY / length) * stepPx;
  const meterPerStep = stepPx * Math.hypot((stepX / stepPx) * cellX, (stepY / stepPx) * cellY);
  const rise = meterPerStep * Math.tan(altitudeRad);
  const maxSteps = Math.max(1, Math.floor(maxDist / Math.max(meterPerStep, 1e-6)));
  let reported = -1;
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * width;
    for (let col = 0; col < width; col += 1) {
      const index = rowOffset + col;
      if (!valid[index] || !Number.isFinite(terrain[index])) continue;
      const start = filled[index];
      for (let step = 1; step <= maxSteps; step += 1) {
        const sampleCol = col + step * stepX;
        const sampleRow = row + step * stepY;
        if (
          sampleCol < 0 ||
          sampleRow < 0 ||
          sampleCol > width - 1 ||
          sampleRow > height - 1
        ) {
          break;
        }
        const occluder =
          filled[Math.round(sampleRow) * width + Math.round(sampleCol)];
        if (occluder > start + step * rise + heightBias) {
          factor[index] = castShade;
          break;
        }
      }
    }
    if (onProgress) {
      const percent = Math.floor(((row + 1) * 100) / height);
      if (percent >= reported + 10 || percent === 100) {
        reported = percent;
        onProgress(percent);
      }
    }
  }
  let shadowPixels = 0;
  for (let i = 0; i < factor.length; i += 1) {
    if (valid[i] && factor[i] !== 1) shadowPixels += 1;
  }
  return {
    factor,
    shadowPixels,
    maxSteps,
    meterPerStep,
  };
}

export function separableBlur(values, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  let weight = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-0.5 * (i / sigma) ** 2);
    kernel[i + radius] = value;
    weight += value;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= weight;
  const horizontal = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sample = Math.min(width - 1, Math.max(0, x + k));
        sum += values[row + sample] * kernel[k + radius];
      }
      horizontal[row + x] = sum;
    }
  }
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sample = Math.min(height - 1, Math.max(0, y + k));
        sum += horizontal[sample * width + x] * kernel[k + radius];
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

function lanczos(distance) {
  if (distance === 0) return 1;
  const absolute = Math.abs(distance);
  if (absolute >= 3) return 0;
  const pix = Math.PI * distance;
  return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
}

function resizeChannel(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;
  const filterX = Math.max(scaleX, 1);
  const filterY = Math.max(scaleY, 1);
  const supportX = 3 * filterX;
  const supportY = 3 * filterY;
  const horizontal = new Float32Array(targetWidth * sourceHeight);
  for (let y = 0; y < sourceHeight; y += 1) {
    const row = y * sourceWidth;
    const outRow = y * targetWidth;
    for (let x = 0; x < targetWidth; x += 1) {
      const center = (x + 0.5) * scaleX - 0.5;
      const start = Math.max(0, Math.ceil(center - supportX));
      const end = Math.min(sourceWidth - 1, Math.floor(center + supportX));
      let sum = 0;
      let weight = 0;
      for (let sample = start; sample <= end; sample += 1) {
        const kernel = lanczos((sample - center) / filterX);
        if (kernel === 0) continue;
        sum += source[row + sample] * kernel;
        weight += kernel;
      }
      horizontal[outRow + x] = weight === 0 ? 0 : sum / weight;
    }
  }
  const out = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const center = (y + 0.5) * scaleY - 0.5;
    const start = Math.max(0, Math.ceil(center - supportY));
    const end = Math.min(sourceHeight - 1, Math.floor(center + supportY));
    const outRow = y * targetWidth;
    for (let x = 0; x < targetWidth; x += 1) {
      let sum = 0;
      let weight = 0;
      for (let sample = start; sample <= end; sample += 1) {
        const kernel = lanczos((sample - center) / filterY);
        if (kernel === 0) continue;
        sum += horizontal[sample * targetWidth + x] * kernel;
        weight += kernel;
      }
      out[outRow + x] = weight === 0 ? 0 : sum / weight;
    }
  }
  return out;
}

export function resizeGray(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  return resizeChannel(source, sourceWidth, sourceHeight, targetWidth, targetHeight);
}

export function resizeRgba(rgba, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const count = sourceWidth * sourceHeight;
  const channels = [0, 1, 2, 3].map((channel) => {
    const plane = new Float32Array(count);
    for (let i = 0; i < count; i += 1) plane[i] = rgba[i * 4 + channel];
    return resizeChannel(plane, sourceWidth, sourceHeight, targetWidth, targetHeight);
  });
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const outCount = targetWidth * targetHeight;
  for (let i = 0; i < outCount; i += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      out[i * 4 + channel] = Math.round(
        Math.min(255, Math.max(0, channels[channel][i])),
      );
    }
  }
  return out;
}
