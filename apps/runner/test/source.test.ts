import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { importedSource, unzip } from "../src/source.ts";

// Independent ZIP/CRC implementation: Python stdlib constructs bounded synthetic archives.
function archive(mode: "valid" | "traversal" | "symlink" | "checksum"): Buffer {
  return execFileSync("python3", ["-c", `
import io,json,hashlib,zipfile,sys
mode=sys.argv[1]
data=b'fixture source text'
path='source/src/main.cpp' if mode!='traversal' else '../escape.cpp'
manifest={'format':'hardwire-archive','formatVersion':1,'files':[{'path':path,'byteSize':len(data),'sha256':hashlib.sha256(data).hexdigest() if mode!='checksum' else '0'*64}]}
out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('manifest.json',json.dumps(manifest))
 if mode=='symlink':
  info=zipfile.ZipInfo(path);info.external_attr=0o120777<<16;z.writestr(info,data)
 else:z.writestr(path,data)
sys.stdout.buffer.write(out.getvalue())
`, mode], { env: { PATH: "/usr/bin:/bin" }, maxBuffer: 1024 * 1024 });
}

test("source importer verifies standard ZIP and manifest checksums before returning source", () => {
  const source = importedSource(archive("valid"));
  assert.deepEqual(Object.keys(source), ["src/main.cpp"]);
  assert.equal(Buffer.from(source["src/main.cpp"]!, "base64").toString(), "fixture source text");
  assert.throws(() => importedSource(archive("checksum")), /checksum/);
});

test("source ZIP rejects traversal, symlinks and truncated central directories", () => {
  assert.throws(() => unzip(archive("traversal")), /Unsafe/);
  assert.throws(() => unzip(archive("symlink")), /Unsafe/);
  assert.throws(() => unzip(archive("valid").subarray(0, -4)), /ZIP/);
});
