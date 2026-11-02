"""Convert a ComfyUI editor-format workflow into the API format /prompt wants.

ComfyUI ships its curated templates in editor format (nodes + links + widget
value arrays). The /prompt endpoint only accepts API format (a flat map of
node id -> {class_type, inputs}), so a template cannot be submitted as-is.
This walks the links, pairs widget values with their schema names from a live
/object_info dump, and prunes to the subgraph that actually feeds the outputs
you asked for -- the preview and extra-bake branches of a big template are
dead weight on a headless run.

  python -I tools/comfy-frontend-to-api.py in.json out.json \\
      --object-info object_info.json --keep Save3DAdvanced

Bypass nodes (mode 4) and muted nodes (mode 2) are resolved the way the
editor resolves them: a bypassed node forwards its first type-matching input
to its output, a muted node is dropped.
"""
import argparse
import json
import sys

# Editor-only nodes: they carry no execution, they just shuttle links around.
PASSTHROUGH = {"Reroute", "PrimitiveNode"}
UI_ONLY = {"Note", "MarkdownNote"}


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def connection_types(object_info):
    """Every type that some node emits as an output. Anything an input
    declares that is NOT in this set cannot be wired, so it is a widget --
    which is what decides whether it consumes a widgets_values slot. Deriving
    the set beats hardcoding type names: ComfyUI writes combos as the literal
    type "COMBO" in current versions and as a bare list of choices in older
    ones, and keeps adding widget types like LOAD_3D."""
    types = set()
    for schema in object_info.values():
        for out in schema.get("output") or []:
            if isinstance(out, str):
                types.update(part.strip() for part in out.split(","))
            elif isinstance(out, list):
                types.update(str(o).strip() for o in out)
    return types


# Types that are always drawn as a widget, even though a node may also emit
# them as an output (PrimitiveInt emits INT, and INT is still a widget).
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}


def widget_names(schema, sockets):
    """Widget inputs, in the order the editor stores widgets_values.

    An input is a widget when its type is one of the always-widget types, a
    legacy inline choice list, or a type nothing emits as an output -- that
    last clause is what catches editor-only state types such as LOAD_3D
    without having to enumerate them.
    """
    names = []
    for group in ("required", "optional"):
        for name, spec in (schema.get("input", {}).get(group) or {}).items():
            if not isinstance(spec, list) or not spec:
                continue
            kind = spec[0]
            if isinstance(kind, list):
                names.append(name)  # legacy inline choice list
                continue
            parts = {part.strip() for part in str(kind).split(",")}
            if (parts & WIDGET_TYPES) or not (parts & sockets):
                names.append(name)
                # The editor draws a "control_after_generate" widget right
                # after every seed, and stores its value in widgets_values,
                # but the backend schema has no such input. Without a
                # placeholder every widget after the seed shifts by one.
                if name in ("seed", "noise_seed"):
                    names.append(None)
    return names


def build(front, object_info, keep_classes):
    sockets = connection_types(object_info)
    nodes = {n["id"]: n for n in front.get("nodes", [])}
    # link id -> (origin node id, origin slot index)
    links = {}
    for link in front.get("links", []):
        if isinstance(link, list) and len(link) >= 6:
            links[link[0]] = (link[1], link[2])

    def origin(node_id, slot_index):
        """Resolve an input slot to a concrete [node_id, slot] pair, walking
        through reroutes and bypassed nodes."""
        node = nodes.get(node_id)
        if node is None:
            return None
        inputs = node.get("inputs") or []
        if slot_index >= len(inputs):
            return None
        link_id = inputs[slot_index].get("link")
        if link_id is None:
            return None
        src = links.get(link_id)
        if src is None:
            return None
        src_id, src_slot = src
        src_node = nodes.get(src_id)
        if src_node is None:
            return None
        mode = src_node.get("mode", 0)
        cls = src_node.get("type")
        if cls in PASSTHROUGH or mode == 4:
            # Bypassed or reroute: forward the input carrying the same type.
            want = (src_node.get("outputs") or [{}])[src_slot].get("type") \
                if src_slot < len(src_node.get("outputs") or []) else None
            for i, inp in enumerate(src_node.get("inputs") or []):
                if want is None or inp.get("type") == want:
                    resolved = origin(src_id, i)
                    if resolved:
                        return resolved
            return None
        if mode == 2:  # muted
            return None
        return [str(src_id), src_slot]

    api = {}
    for node_id, node in nodes.items():
        cls = node.get("type")
        if cls in PASSTHROUGH or cls in UI_ONLY:
            continue
        if node.get("mode", 0) in (2, 4):
            continue
        schema = object_info.get(cls)
        if schema is None:
            print("warning: no schema for %s (node %s)" % (cls, node_id), file=sys.stderr)
            continue
        inputs = {}
        # Widgets, paired positionally with their schema names.
        values = node.get("widgets_values") or []
        if isinstance(values, dict):
            inputs.update(values)
        else:
            for name, value in zip(widget_names(schema, sockets), values):
                if name is not None:
                    inputs[name] = value
        # Connected sockets override / add to that.
        for i, slot in enumerate(node.get("inputs") or []):
            name = slot.get("name")
            if not name:
                continue
            resolved = origin(node_id, i)
            if resolved is not None:
                inputs[name] = resolved
            elif name in inputs and slot.get("widget") is None:
                # An unconnected socket must not be left holding a widget value.
                inputs.pop(name)
        api[str(node_id)] = {"class_type": cls, "inputs": inputs, "_meta": {"title": node.get("title") or cls}}

    if not keep_classes:
        return api

    # Prune to everything the kept output nodes actually depend on.
    wanted = {nid for nid, n in api.items() if n["class_type"] in keep_classes}
    if not wanted:
        raise SystemExit("none of the kept classes %s are in the graph" % sorted(keep_classes))
    seen = set()
    stack = list(wanted)
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        for value in api.get(nid, {}).get("inputs", {}).values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                stack.append(value[0])
    return {nid: node for nid, node in api.items() if nid in seen}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument("--object-info", required=True)
    ap.add_argument("--keep", action="append", default=[],
                    help="output node class to keep; everything it does not feed is pruned")
    args = ap.parse_args()

    api = build(load(args.source), load(args.object_info), set(args.keep))
    with open(args.dest, "w", encoding="utf-8") as fh:
        json.dump(api, fh, indent=2)
    print("wrote %s with %d nodes" % (args.dest, len(api)))


if __name__ == "__main__":
    main()
