const marker = Buffer.from("\n__idrive__\n");

export function embeddedPayload(wrapper: Buffer): Buffer {
  const markerOffset = wrapper.indexOf(marker);
  if (markerOffset === -1) {
    throw new Error("IDrive self-extractor marker was not found");
  }
  return wrapper.subarray(markerOffset + marker.length);
}

export function engineArchiveForArchitecture(
  architecture: NodeJS.Architecture,
): string {
  if (architecture === "x64") {
    return "IDrive_linux_64bit.tar.gz";
  }
  throw new Error(`Unsupported architecture: ${architecture}`);
}
