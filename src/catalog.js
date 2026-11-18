import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADCODE_DEM } from "./params.js";
import { loadGeojson } from "./vector.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function codeOf(adcode) {
  const text = String(adcode);
  return /^\d+$/.test(text) ? text.padStart(6, "0") : text;
}

function propertiesOf(feature) {
  return feature.properties || {};
}

function demAdcodeFor(layer, groupAdcode, properties) {
  if (layer === "state" || layer === "province") return codeOf(groupAdcode);
  const candidates = [];
  const parent = properties.parent?.adcode;
  if (parent != null) candidates.push(codeOf(parent));
  for (const route of [...(properties.acroutes || [])].reverse()) candidates.push(codeOf(route));
  candidates.push(codeOf(groupAdcode));
  return candidates.find((code) => ADCODE_DEM[code]) || null;
}

function jobFromFeature(layer, groupAdcode, filePath, feature) {
  const properties = propertiesOf(feature);
  const adcode = codeOf(properties.adcode);
  const demAdcode = demAdcodeFor(layer, groupAdcode, properties);
  return {
    layer,
    adcode,
    groupAdcode: codeOf(groupAdcode),
    name: properties.name || adcode,
    demAdcode,
    demPrefix: demAdcode ? ADCODE_DEM[demAdcode] : null,
    filePath,
    feature,
  };
}

function readFeatures(filePath) {
  return loadGeojson(filePath).features;
}

export function stateJobs() {
  const dir = path.join(repoDir, "assets", "state");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = path.join(dir, name);
      const adcode = name.replace(/^districts_/, "").replace(/\.json$/, "");
      const feature = readFeatures(filePath)[0];
      const job = jobFromFeature("state", adcode, filePath, feature);
      job.adcode = codeOf(adcode);
      return job;
    });
}

export function provinceJobs() {
  const filePath = path.join(repoDir, "assets", "province", "100000_full.json");
  return readFeatures(filePath)
    .filter((feature) => propertiesOf(feature).level === "province")
    .map((feature) => jobFromFeature("province", propertiesOf(feature).adcode, filePath, feature));
}

export function cityJobs(parent) {
  const dir = path.join(repoDir, "assets", "city");
  const wanted = parent ? codeOf(parent) : null;
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith("_full.json"))
    .filter((name) => !wanted || name.startsWith(`${wanted}_`))
    .sort()
    .flatMap((name) => {
      const filePath = path.join(dir, name);
      const groupAdcode = name.replace(/_full\.json$/, "");
      return readFeatures(filePath)
        .filter((feature) => propertiesOf(feature).level === "city")
        .map((feature) => jobFromFeature("city", groupAdcode, filePath, feature));
    });
}

export function districtJobs(parent) {
  const dir = path.join(repoDir, "assets", "districts");
  const wanted = parent ? codeOf(parent) : null;
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !wanted || name === `districts_${wanted}.json`)
    .sort()
    .flatMap((name) => {
      const filePath = path.join(dir, name);
      const groupAdcode = name.replace(/^districts_/, "").replace(/\.json$/, "");
      return readFeatures(filePath)
        .filter((feature) => propertiesOf(feature).level === "district")
        .map((feature) => jobFromFeature("district", groupAdcode, filePath, feature));
    });
}

export function jobsForLayer(layer, parent) {
  if (layer === "state") return stateJobs();
  if (layer === "province") return provinceJobs();
  if (layer === "city") return cityJobs(parent);
  if (layer === "district") return districtJobs(parent);
  throw new Error(`Unknown layer: ${layer}`);
}

export function findJob(adcode) {
  const code = codeOf(adcode);
  const groups = [stateJobs, provinceJobs, () => cityJobs(), () => districtJobs()];
  for (const load of groups) {
    const found = load().find((job) => job.adcode === code);
    if (found) return found;
  }
  return null;
}
