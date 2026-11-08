// Ported from v3 packages/sources/src/raster.ts (V3_PORT: keep; owner M6 2026-11-08).
import { sourceInputLimit } from "./limits.ts";

export interface RasterText { mime: string; method: "local-ocr-v1"; parts: Array<{ locator: string; text: string }> }

// Fixed local code; document bytes are stdin data, never command or script text.
const rasterScript = String.raw`
$ErrorActionPreference='Stop'
$inputStream=$null
try {
 Add-Type -AssemblyName System.Runtime.WindowsRuntime
 [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
 [Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
 [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
 function Await($operation,[Type]$type) {
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'} | Select-Object -First 1
  $task=$method.MakeGenericMethod($type).Invoke($null,@($operation))
  if(-not $task.Wait(15000)){throw 'Local decoder timed out'}
  return ,$task.Result
 }
 $request=ConvertFrom-Json ([Console]::In.ReadToEnd())
 $bytes=[Convert]::FromBase64String($request.base64)
 $limit=[long]$request.maxInputBytes
 if($limit -lt 1 -or $limit -gt 209715200 -or $bytes.Length -eq 0 -or $bytes.Length -gt $limit -or ($request.kind -eq 'image' -and $bytes.Length -gt 4194304)){throw 'Input byte bound'}
 $inputStream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
 $writer=[Windows.Storage.Streams.DataWriter]::new($inputStream)
 try{$writer.WriteBytes($bytes);$null=Await ($writer.StoreAsync()) ([uint32]);$null=$writer.DetachStream()}finally{$writer.Dispose()}
 $inputStream.Seek(0)
 if($request.kind -eq 'image') {
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($inputStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $codec=if($request.mime -eq 'image/png'){[Windows.Graphics.Imaging.BitmapDecoder]::PngDecoderId}else{[Windows.Graphics.Imaging.BitmapDecoder]::JpegDecoderId}
  if($decoder.DecoderInformation.CodecId -ne $codec -or $decoder.PixelWidth -lt 1 -or $decoder.PixelHeight -lt 1 -or [double]$decoder.PixelWidth*$decoder.PixelHeight -gt 20000000){throw 'Image codec or pixel bound'}
  $result=@{width=$decoder.PixelWidth;height=$decoder.PixelHeight}
 } elseif($request.kind -eq 'pdf') {
  [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
  $pdf=Await ([Windows.Data.Pdf.PdfDocument]::LoadFromStreamAsync($inputStream)) ([Windows.Data.Pdf.PdfDocument])
  if($pdf.PageCount -lt 1 -or $pdf.PageCount -gt 12){throw 'PDF page bound'}
  $parts=[Collections.Generic.List[object]]::new();$total=0
  for($i=0;$i -lt $pdf.PageCount;$i++) {
   $page=$pdf.GetPage($i);$output=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new();$reader=$null
   try {
    $width=[double]$page.Size.Width;$height=[double]$page.Size.Height
    if($width -le 0 -or $height -le 0 -or $width -gt 20000 -or $height -gt 20000){throw 'PDF dimensions'}
    $scale=[Math]::Min(1.8,2400/[Math]::Max($width,$height))
    $options=[Windows.Data.Pdf.PdfPageRenderOptions]::new();$options.DestinationWidth=[uint32][Math]::Ceiling($width*$scale);$options.DestinationHeight=[uint32][Math]::Ceiling($height*$scale)
    $operation=$page.RenderToStreamAsync($output,$options)
    $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'} | Select-Object -First 1
    $task=$method.Invoke($null,@($operation));if(-not $task.Wait(15000)){throw 'PDF rendering timed out'}
    $total+=$output.Size;if($output.Size -eq 0 -or $total -gt 8388608){throw 'Raster byte bound'}
    $output.Seek(0);$reader=[Windows.Storage.Streams.DataReader]::new($output);$null=Await ($reader.LoadAsync([uint32]$output.Size)) ([uint32])
    $png=New-Object byte[] ([int]$output.Size);$reader.ReadBytes($png);$null=$reader.DetachStream()
    $parts.Add(@{page=$i+1;png=[Convert]::ToBase64String($png)})
   } finally {if($null -ne $reader){$reader.Dispose()};$output.Dispose();$page.Dispose()}
  }
  $result=@{pages=@($parts.ToArray())}
 } else {throw 'Unsupported raster kind'}
 [Console]::Out.Write(($result | ConvertTo-Json -Depth 4 -Compress))
} catch {[Console]::Error.WriteLine('Local raster decoding failed; check format, dimensions and limits.');exit 1}
finally {if($null -ne $inputStream){$inputStream.Dispose()}}
`;

async function local(command: string[], input: Uint8Array, outputLimit: number, deadline: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new Error("Local OCR cancelled; no source admitted");
  const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("Local OCR exceeded its 45-second limit");
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let stopped: Error | undefined;
  const stop = (error: Error) => { stopped ??= error; child.kill(); };
  const cancel = () => stop(new Error("Local OCR cancelled; no source admitted"));
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop(new Error("Local OCR exceeded its 45-second limit")), remaining);
  const bounded = async (stream: ReadableStream<Uint8Array>, max: number) => {
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const bytes of stream) { length += bytes.length; if (length > max) { const error = new Error("Local OCR output exceeded its bound"); stop(error); throw error; } chunks.push(bytes); }
    return Buffer.concat(chunks);
  };
  try {
    if (signal?.aborted) cancel();
    const send = async () => { await child.stdin.write(input); await child.stdin.end(); };
    const [, output, , code] = await Promise.all([send(), bounded(child.stdout, outputLimit), bounded(child.stderr, 8192), child.exited]);
    if (stopped) throw stopped;
    if (signal?.aborted) throw new Error("Local OCR cancelled; no source admitted");
    if (code !== 0) throw new Error("Local image/OCR decoding failed. Check readable PNG/JPEG or an unencrypted PDF of at most 12 pages, installed Windows codecs and local Tesseract; no hosted fallback is used.");
    return output;
  } catch (error) { child.kill(); await child.exited; throw stopped ?? error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

/** Local-only OCR; output is an unverified transcription, never assessment evidence. */
export async function extractRasterText(original: Uint8Array, mime: "image/png" | "image/jpeg" | "application/pdf", signal?: AbortSignal, maxInputBytes?: number): Promise<RasterText> {
  if (signal?.aborted) throw new Error("Local OCR cancelled; no source admitted");
  const pdf = mime === "application/pdf", bytes = Buffer.from(original);
  const inputLimit = sourceInputLimit(maxInputBytes);
  if (!bytes.length || bytes.length > (pdf ? inputLimit : Math.min(inputLimit, 4 * 1024 * 1024))) throw new Error("Image originals retain a 4 MiB limit; scanned PDF input must fit its authorized bound");
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString() === "IHDR";
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!(pdf ? bytes.subarray(0, 5).toString() === "%PDF-" : mime === "image/png" ? png : jpeg)) throw new Error("Image/PDF signature does not match the source format");
  if (png && (!bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 20000000)) throw new Error("Image exceeds the 20-million-pixel bound");
  const shell = Bun.which("powershell.exe"), tesseract = Bun.which("tesseract");
  if (!shell || !tesseract || process.platform !== "win32") throw new Error("Local image/OCR sources require installed Windows PowerShell/WinRT and Tesseract on PATH. Export reviewed text instead; no hosted OCR fallback is used.");
  const deadline = Date.now() + 45000;
  const listing = new TextDecoder("utf-8", { fatal: true }).decode(await local([tesseract, "--list-langs"], new Uint8Array(), 8192, deadline, signal));
  const languages = ["eng", "spa"].filter(lang => listing.split(/\r?\n/).some(line => line.trim() === lang));
  if (!languages.length) throw new Error("Local OCR requires installed English or Spanish Tesseract data; export reviewed text instead");
  const raw = await local([shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", rasterScript], Buffer.from(JSON.stringify({ kind: pdf ? "pdf" : "image", mime, maxInputBytes: inputLimit, base64: bytes.toString("base64") })), 12 * 1024 * 1024, deadline, signal);
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch (cause) { throw new Error("Invalid local raster decoder output", { cause }); }
  if (!decoded || typeof decoded !== "object") throw new Error("Invalid local raster decoder output");
  let pages: Array<{ locator: string; image: Buffer }>;
  if (pdf) {
    if (!("pages" in decoded) || !Array.isArray(decoded.pages) || !decoded.pages.length || decoded.pages.length > 12) throw new Error("Invalid local PDF raster output");
    let total = 0;
    pages = decoded.pages.map((page: unknown, index: number) => {
      if (!page || typeof page !== "object" || !("page" in page) || !("png" in page) || page.page !== index + 1 || typeof page.png !== "string" || page.png.length > 11184812 || !/^[A-Za-z0-9+/]*={0,2}$/.test(page.png)) throw new Error("Invalid local PDF raster page");
      const image = Buffer.from(page.png, "base64"); total += image.length;
      if (!image.length || total > 8 * 1024 * 1024 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid or oversized local raster output");
      return { locator: `page ${page.page}`, image };
    });
  } else {
    if (!("width" in decoded) || !("height" in decoded) || typeof decoded.width !== "number" || typeof decoded.height !== "number" || !Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.width * decoded.height > 20000000) throw new Error("Invalid local image dimensions");
    pages = [{ locator: "image original", image: bytes }];
  }
  const parts: RasterText["parts"] = []; let characters = 0;
  for (const page of pages) {
    const output = await local([tesseract, "stdin", "stdout", "-l", languages.join("+"), "--dpi", "150"], page.image, 256 * 1024, deadline, signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(output).replace(/\x00/g, "").trim();
    if (pdf && !text) throw new Error(`No readable OCR text on ${page.locator}; review the original or export the diagram as a PNG/JPEG source`);
    characters += text.length; if (characters > 500000) throw new Error("Local OCR text exceeded its bound");
    parts.push({ locator: page.locator, text: text || "No readable OCR text. Image-only source; inspect the original. A compatible model may view it only after explicit lesson sharing consent." });
  }
  return { mime, method: "local-ocr-v1", parts };
}
