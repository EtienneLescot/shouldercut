"""Generate the Muse mascot mesh from a reference photo, through ComfyUI.

The app ships one 3D asset, public/mascot/jolly.glb. This is how it is made,
so the asset is reproducible rather than a binary someone has to trust:

  python -I tools/make-mascot.py reference.png --out public/mascot/jolly.glb

It uploads the reference, submits the converted image-to-3D graph, waits, and
pulls the GLB back. The graph itself comes from ComfyUI's own curated
template, projected into API format by tools/comfy-frontend-to-api.py.

Defaults are tuned for a 170px on-screen mascot, not for a print-quality
asset: faces and texture resolution are both far below the template's, which
targets a hero model. Raise them with --faces / --texture if you want the
heavy version.
"""
import argparse
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
import uuid

DEFAULT_SERVER = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

# Node ids in the converted graph. They come from the upstream template, so
# they are stable for a given template version and checked on load below.
NODE_LOAD_IMAGE = "122"
NODE_CROP = "312"
NODE_DECIMATE = "186"
NODE_TEXTURE_RES = "288"
NODE_REMESH = "241"
NODE_BACKEND_SWITCH = "316"
NODE_SAVE = "322"

EXPECTED = {
    NODE_LOAD_IMAGE: "LoadImage",
    NODE_CROP: "ImageCropToMask",
    NODE_DECIMATE: "DecimateMesh",
    NODE_TEXTURE_RES: "PrimitiveInt",
    NODE_REMESH: "RemeshMesh",
    NODE_BACKEND_SWITCH: "PrimitiveBoolean",
    NODE_SAVE: "Save3DAdvanced",
}


def post_json(server, path, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(server + path, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get_json(server, path):
    with urllib.request.urlopen(server + path, timeout=30) as r:
        return json.loads(r.read().decode())


def upload_image(server, path):
    """Multipart by hand: one upload is not worth a dependency."""
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "image/png"
    boundary = "----shouldercut" + uuid.uuid4().hex
    with open(path, "rb") as fh:
        blob = fh.read()
    parts = [
        ("--%s\r\nContent-Disposition: form-data; name=\"image\"; filename=\"%s\"\r\n"
         "Content-Type: %s\r\n\r\n" % (boundary, name, ctype)).encode(),
        blob,
        ("\r\n--%s\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n"
         "--%s--\r\n" % (boundary, boundary)).encode(),
    ]
    req = urllib.request.Request(
        server + "/upload/image", data=b"".join(parts),
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())["name"]


def patch(graph, image_name, args):
    for nid, cls in EXPECTED.items():
        got = graph.get(nid, {}).get("class_type")
        if got != cls:
            raise SystemExit("graph node %s is %s, expected %s -- regenerate the "
                             "API graph from the current template" % (nid, got, cls))
    graph[NODE_LOAD_IMAGE]["inputs"]["image"] = image_name
    graph[NODE_CROP]["inputs"]["background"] = "#000000"
    graph[NODE_DECIMATE]["inputs"]["target_face_count"] = args.faces
    graph[NODE_TEXTURE_RES]["inputs"]["value"] = args.texture
    graph[NODE_BACKEND_SWITCH]["inputs"]["value"] = args.backend == "trellis"
    graph[NODE_SAVE]["inputs"]["filename_prefix"] = "3d/" + args.name
    # RemeshMesh carries a dynamic combo, whose sub-widgets the editor stores
    # inline; the converter cannot place those positionally, so set them here.
    graph[NODE_REMESH]["inputs"] = {
        "mesh": graph[NODE_REMESH]["inputs"]["mesh"],
        "resolution": args.remesh,
        "sign_mode": "solid",
        "sign_mode.fill": 20.0,
        "sign_mode.qef": False,
        "band": 1.0,
        "project_back": 0.0,
        "fix_poles": False,
        "smooth_iters": 20,
        "drop_small_components": 0.01,
        "precluster_max_verts": 20000000,
    }
    return graph


def wait_for(server, prompt_id, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        hist = get_json(server, "/history/" + prompt_id)
        if prompt_id in hist:
            return hist[prompt_id]
        time.sleep(5)
    raise SystemExit("timed out after %ds waiting for %s" % (timeout, prompt_id))


def find_model(entry):
    for out in entry.get("outputs", {}).values():
        for items in out.values():
            if not isinstance(items, list):
                continue
            for item in items:
                if isinstance(item, dict) and str(item.get("filename", "")).endswith(
                        (".glb", ".gltf")):
                    return item
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("reference", help="reference photo: one subject, plain background")
    ap.add_argument("--graph", default="tools/mascot-image-to-3d.api.json")
    ap.add_argument("--out", default="public/mascot/jolly.glb")
    ap.add_argument("--name", default="jolly")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--backend", choices=("pixal3d", "trellis"), default="pixal3d")
    ap.add_argument("--faces", type=int, default=24000, help="target face count")
    ap.add_argument("--texture", type=int, default=1024, help="texture atlas resolution")
    ap.add_argument("--remesh", type=int, default=512, help="remesh voxel resolution")
    ap.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args()

    with open(args.graph, encoding="utf-8") as fh:
        graph = json.load(fh)

    image_name = upload_image(args.server, args.reference)
    print("uploaded", image_name)

    graph = patch(graph, image_name, args)
    try:
        res = post_json(args.server, "/prompt",
                        {"prompt": graph, "client_id": "shouldercut-mascot"})
    except urllib.error.HTTPError as e:
        raise SystemExit("ComfyUI rejected the graph:\n" + e.read().decode()[:2000])
    errors = res.get("node_errors") or {}
    if errors:
        raise SystemExit("ComfyUI rejected the graph:\n" + json.dumps(errors, indent=1)[:2000])
    prompt_id = res["prompt_id"]
    print("queued", prompt_id, "- this takes a few minutes")

    entry = wait_for(args.server, prompt_id, args.timeout)
    status = entry.get("status", {})
    if status.get("status_str") == "error":
        for message in status.get("messages", [])[-4:]:
            print("  ", json.dumps(message)[:400])
        raise SystemExit("generation failed")

    item = find_model(entry)
    if not item:
        raise SystemExit("no .glb in the outputs: " + json.dumps(entry.get("outputs", {}))[:600])

    query = urllib.parse.urlencode({
        "filename": item["filename"],
        "subfolder": item.get("subfolder", ""),
        "type": item.get("type", "output"),
    })
    with urllib.request.urlopen(args.server + "/view?" + query, timeout=300) as r:
        data = r.read()
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "wb") as fh:
        fh.write(data)
    print("wrote %s (%.1f MB)" % (args.out, len(data) / 1e6))


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (only needed in main)
    main()
