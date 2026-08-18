const MAX_COMPONENT = 65_535;

export function parseChromeVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`invalid Chrome version: ${version || '(missing)'}`);
  }

  const parts = version.split('.');
  if (parts.length < 1 || parts.length > 4) {
    throw new Error(`invalid Chrome version: ${version}`);
  }

  const components = parts.map((part) => {
    if (!/^(0|[1-9]\d*)$/.test(part)) {
      throw new Error(`invalid Chrome version: ${version}`);
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value > MAX_COMPONENT) {
      throw new Error(`invalid Chrome version: ${version}`);
    }
    return value;
  });

  if (components.every((component) => component === 0)) {
    throw new Error(`invalid Chrome version: ${version}`);
  }

  return components;
}

export function parseChromeTag(tag) {
  if (typeof tag !== 'string' || !/^v[^\s]+$/.test(tag)) {
    throw new Error(`invalid release tag: ${tag || '(missing)'}`);
  }

  const version = tag.slice(1);
  const components = parseChromeVersion(version);
  if (components.length !== 3) {
    throw new Error(`invalid release tag: ${tag}; expected vX.Y.Z`);
  }

  return { tag, version, components };
}
