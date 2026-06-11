#!/usr/bin/env python3
"""
Build a BAS business-pattern corpus for the Pugi/Anvil RAG.

The existing OES corpus focuses on syntax and raw source chunks. This builder
creates higher-level "business document bundle" records from a BAS dump:
Document metadata + form XML + form module + object module + manager module +
print templates. It is intended to be embedded locally with
oes-knowledge-embedder-local.py and bulk-loaded to Pugi/Anvil with the existing
oes-anvil-bulk-ingest.py path.
"""
from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable


DEFAULT_SOURCE = Path("/Volumes/T9/AI/BAS_BUH")
DEFAULT_OUT = Path("var/rag/bas-business-corpus.jsonl")
NAMESPACE = "bas-business-patterns"
WORKSPACE = "oes_ces"
SUPPORTING_DIRS = {
    "CommonModules": "common-module",
    "Roles": "role-rights",
    "Subsystems": "interface-subsystem",
    "CommonCommands": "common-command",
    "CommandGroups": "command-group",
    "Reports": "report",
}

CYRILLIC_TO_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "h", "ґ": "g", "д": "d",
    "е": "e", "ё": "e", "є": "ie", "ж": "zh", "з": "z", "и": "y",
    "і": "i", "ї": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "shch", "ы": "y", "э": "e", "ю": "iu", "я": "ia",
}


def read_text(path: Path, limit: int | None = None) -> str:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    if limit and len(text) > limit:
        return text[:limit] + "\n...<truncated>..."
    return text


def strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_xml(path: Path) -> ET.Element | None:
    try:
        return ET.parse(path).getroot()
    except ET.ParseError:
        return None


def descendants(root: ET.Element | None, local_name: str) -> Iterable[ET.Element]:
    if root is None:
        return []
    return (el for el in root.iter() if strip_ns(el.tag) == local_name)


def first_text(parent: ET.Element | None, local_name: str) -> str:
    for el in descendants(parent, local_name):
        if el.text:
            return el.text.strip()
    return ""


def synonym_text(root: ET.Element | None) -> str:
    values: list[str] = []
    for content in descendants(root, "content"):
        if content.text and content.text.strip():
            value = content.text.strip()
            if value not in values:
                values.append(value)
    return " / ".join(values[:4])


def transliterate_identifier(name: str) -> str:
    chunks: list[str] = []
    current = ""
    for ch in name:
        if ch.isascii() and ch.isalnum():
            current += ch
            continue
        low = ch.lower()
        if low in CYRILLIC_TO_LATIN:
            piece = CYRILLIC_TO_LATIN[low]
            current += piece[:1].upper() + piece[1:] if ch.isupper() else piece
            continue
        if current:
            chunks.append(current)
            current = ""
    if current:
        chunks.append(current)
    if not chunks:
        return "GeneratedObject"
    ident = "".join(part[:1].upper() + part[1:] for part in chunks)
    if ident and ident[0].isdigit():
        ident = "Object" + ident
    return ident


def compact_list(values: Iterable[str], max_items: int = 24) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        value = (value or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
        if len(out) >= max_items:
            break
    return out


def extract_properties(doc_root: ET.Element | None) -> dict[str, object]:
    properties = next(descendants(doc_root, "Properties"), None)
    attributes: list[str] = []
    tables: list[str] = []
    standard_attrs: list[str] = []
    # BAS dump stores user-defined attributes under Document/ChildObjects,
    # while standard attributes live under Document/Properties. Keep all
    # Attribute nodes in the bundle so retrieval sees header and table fields.
    for attr in descendants(doc_root, "Attribute"):
        name = first_text(attr, "Name")
        if name:
            attributes.append(name)
    for section in descendants(doc_root, "TabularSection"):
        name = first_text(section, "Name")
        if name:
            tables.append(name)
    for std_attr in descendants(properties, "StandardAttribute"):
        name = std_attr.attrib.get("name", "")
        if name:
            standard_attrs.append(name)
    return {
        "name": first_text(properties, "Name"),
        "synonym": synonym_text(properties),
        "attributes": compact_list(attributes, 80),
        "tabularSections": compact_list(tables, 40),
        "standardAttributes": compact_list(standard_attrs, 40),
        "posting": first_text(properties, "Posting"),
        "useStandardCommands": first_text(properties, "UseStandardCommands"),
        "numberType": first_text(properties, "NumberType"),
        "numberLength": first_text(properties, "NumberLength"),
        "numberPeriodicity": first_text(properties, "NumberPeriodicity"),
    }


def extract_form_summary(form_xml: Path) -> dict[str, object]:
    root = parse_xml(form_xml)
    events = []
    for event in descendants(root, "Event"):
        name = event.attrib.get("name", "")
        handler = (event.text or "").strip()
        if name or handler:
            events.append(f"{name}:{handler}" if handler else name)
    fields = []
    groups = []
    tables = []
    for el in root.iter() if root is not None else []:
        tag = strip_ns(el.tag)
        name = el.attrib.get("name", "")
        if not name:
            continue
        if tag in {"InputField", "CheckBoxField", "Decoration"}:
            fields.append(name)
        elif tag in {"UsualGroup", "Pages", "Page"}:
            groups.append(name)
        elif tag in {"Table", "TableBox", "SpreadsheetDocumentField"}:
            tables.append(name)
    raw = read_text(form_xml, 14000)
    return {
        "path": str(form_xml),
        "events": compact_list(events, 60),
        "fields": compact_list(fields, 80),
        "groups": compact_list(groups, 50),
        "tables": compact_list(tables, 30),
        "hasUsePostingMode": "UsePostingMode" in raw,
        "hasVisibilityRules": bool(re.search(r"Видим|Visible|DefaultVisible", raw)),
        "hasEnabledRules": bool(re.search(r"Доступн|Enabled|ReadOnly", raw)),
    }


def extract_procedures(text: str) -> list[str]:
    names = re.findall(r"(?im)^\s*(?:Процедура|Функция|Procedure|Function)\s+([A-Za-zА-Яа-яЁёІіЇїЄєҐґ_][\wА-Яа-яЁёІіЇїЄєҐґ]*)", text)
    return compact_list(names, 80)


def domain_tags(name: str, attributes: Iterable[str]) -> list[str]:
    hay = (name + " " + " ".join(attributes)).lower()
    rules = [
        ("sales", ["реализа", "продаж", "покупател", "заказ"]),
        ("purchase", ["поступлен", "поставщик", "закуп"]),
        ("warehouse", ["товар", "склад", "номенклатур", "перемещ"]),
        ("bank-cash", ["банк", "касс", "платеж", "денеж", "счет"]),
        ("payroll-hr", ["зарплат", "кадр", "сотруд", "работ", "начислен"]),
        ("fixed-assets", ["ос", "нма", "амортиз", "основн"]),
        ("tax", ["налог", "ндс", "акциз"]),
        ("accounting", ["провод", "бух", "субконто", "счет"]),
        ("production", ["производ", "переработ", "комплектац"]),
        ("service-desk", ["заявк", "обращен", "услуг", "сервис"]),
    ]
    tags = [tag for tag, needles in rules if any(n in hay for n in needles)]
    return tags or ["business-document"]


def render_bundle_content(meta: dict[str, object], forms: list[dict[str, object]],
                          object_module: str, manager_module: str,
                          templates: list[Path]) -> str:
    name = str(meta["name"])
    english_name = transliterate_identifier(name)
    has_posting_handler = bool(re.search(r"ОбработкаПроведения|Posting\s*\(", object_module))
    has_check_handler = bool(re.search(r"ПередЗаписью|ОбработкаПроверкиЗаполнения|BeforeWrite", object_module))
    lines = [
        f"# BAS document business pattern: {name}",
        f"Recommended OES technical name: Document.{english_name}",
        "Technical identifiers in generated OES configs must be English; keep BAS/RU/UA names only as synonym/comment/title labels.",
        f"Synonym labels: {meta.get('synonym') or name}",
        f"Domain tags: {', '.join(domain_tags(name, meta.get('attributes', [])))}",
        "",
        "## Document metadata",
        f"Posting: {meta.get('posting') or 'unknown'}",
        f"Number: type={meta.get('numberType')} length={meta.get('numberLength')} periodicity={meta.get('numberPeriodicity')}",
        f"Standard attributes: {', '.join(meta.get('standardAttributes', []))}",
        f"Business attributes: {', '.join(meta.get('attributes', []))}",
        f"Tabular sections: {', '.join(meta.get('tabularSections', []))}",
        "",
        "## BAS-style form layout pattern",
        "Use command bar; header group with Number, Date, Organization/Firma and operation-specific references; one or more tabular sections with toolbar; footer/additional group with Responsible and Comment; preserve conditional visibility/enabled handlers.",
    ]
    for form in forms:
        lines += [
            f"Form: {Path(str(form['path'])).name}",
            f"  Groups: {', '.join(form.get('groups', []))}",
            f"  Fields: {', '.join(form.get('fields', []))}",
            f"  Tables: {', '.join(form.get('tables', []))}",
            f"  Events: {', '.join(form.get('events', []))}",
            f"  PostingMode={form.get('hasUsePostingMode')} VisibilityRules={form.get('hasVisibilityRules')} EnabledRules={form.get('hasEnabledRules')}",
        ]
    lines += [
        "",
        "## Module pattern",
        f"Object module procedures: {', '.join(extract_procedures(object_module))}",
        f"Manager module procedures: {', '.join(extract_procedures(manager_module))}",
        f"Has posting handler: {has_posting_handler}",
        f"Has before-write/check handlers: {has_check_handler}",
        f"Print templates: {', '.join(p.name for p in templates[:20])}",
    ]
    return "\n".join(lines)


def chunk_text(text: str, size: int) -> list[str]:
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end])
        start = end
    return chunks


def build_records(source: Path, max_artifact_chars: int) -> list[dict[str, object]]:
    docs_root = source / "ConfigFiles" / "Documents"
    records: list[dict[str, object]] = []
    for doc_xml in sorted(docs_root.glob("*.xml")):
        doc_root = parse_xml(doc_xml)
        meta = extract_properties(doc_root)
        name = str(meta.get("name") or doc_xml.stem)
        doc_dir = docs_root / doc_xml.stem
        form_xmls = sorted(doc_dir.glob("Forms/*/Ext/Form.xml"))
        forms = [extract_form_summary(path) for path in form_xmls]
        object_module_path = doc_dir / "Ext" / "ObjectModule.bsl"
        manager_module_path = doc_dir / "Ext" / "ManagerModule.bsl"
        object_module = read_text(object_module_path, max_artifact_chars) if object_module_path.exists() else ""
        manager_module = read_text(manager_module_path, max_artifact_chars) if manager_module_path.exists() else ""
        form_modules = sorted(doc_dir.glob("Forms/*/Ext/Form/Module.bsl"))
        templates = sorted(doc_dir.glob("Templates/**/*"))
        templates = [p for p in templates if p.is_file()]
        english_name = transliterate_identifier(name)
        bundle_meta = {
            "namespace": NAMESPACE,
            "source_corpus": "bas-buh-business-patterns",
            "kind": "document-bundle",
            "bas_name": name,
            "recommended_oes_name": english_name,
            "domain_tags": domain_tags(name, meta.get("attributes", [])),
            "artifacts": {
                "document_xml": str(doc_xml),
                "forms": [str(p) for p in form_xmls],
                "form_modules": [str(p) for p in form_modules],
                "object_module": str(object_module_path) if object_module_path.exists() else "",
                "manager_module": str(manager_module_path) if manager_module_path.exists() else "",
                "templates": [str(p) for p in templates[:50]],
            },
            "attributes": meta.get("attributes", []),
            "tabular_sections": meta.get("tabularSections", []),
            "object_module_procedures": extract_procedures(object_module),
            "manager_module_procedures": extract_procedures(manager_module),
            "forms": forms,
            "requires_english_identifiers": True,
            "labels_go_to_synonym": True,
        }
        content = render_bundle_content(meta, forms, object_module, manager_module, templates)
        records.append({
            "content": content,
            "source": f"BAS_BUH/ConfigFiles/Documents/{doc_xml.name}",
            "title": f"BAS business document pattern: {name}",
            "workspace_id": WORKSPACE,
            "metadata": bundle_meta,
        })
        artifacts = [
            ("document_xml", read_text(doc_xml, max_artifact_chars)),
            ("object_module", object_module),
            ("manager_module", manager_module),
        ]
        artifacts += [(f"form_xml:{p.parent.parent.name}", read_text(p, max_artifact_chars)) for p in form_xmls]
        artifacts += [(f"form_module:{p.parents[2].name}", read_text(p, max_artifact_chars)) for p in form_modules]
        for artifact_kind, text in artifacts:
            if not text.strip():
                continue
            for idx, chunk in enumerate(chunk_text(text, max_artifact_chars)):
                records.append({
                    "content": (
                        f"# BAS artifact for {name}\n"
                        f"Technical-name rule: generated OES identifiers/methods/variables must be English; labels stay in synonym/title/comment.\n"
                        f"Artifact kind: {artifact_kind}\n\n{chunk}"
                    ),
                    "source": f"BAS_BUH/ConfigFiles/Documents/{doc_xml.stem}/{artifact_kind}/{idx}",
                    "title": f"BAS artifact {artifact_kind}: {name}",
                    "workspace_id": WORKSPACE,
                    "metadata": {
                        "namespace": NAMESPACE,
                        "source_corpus": "bas-buh-business-patterns",
                        "kind": "artifact",
                        "artifact_kind": artifact_kind,
                        "bas_name": name,
                        "recommended_oes_name": english_name,
                        "chunk": idx,
                        "requires_english_identifiers": True,
                    },
                })
    records.extend(build_supporting_records(source, max_artifact_chars))
    return records


def build_supporting_records(source: Path, max_artifact_chars: int) -> list[dict[str, object]]:
    cfg_root = source / "ConfigFiles"
    records: list[dict[str, object]] = []
    config_xml = cfg_root / "Configuration.xml"
    if config_xml.exists():
        content = read_text(config_xml, max_artifact_chars)
        records.append({
            "content": (
                "# BAS configuration root pattern\n"
                "Use this to design full OES Configuration metadata: startup behavior, "
                "global configuration settings, included subsystems/interfaces, roles, "
                "languages, common modules, common commands, reports, and ownership links. "
                "Generated technical identifiers must be English ASCII; localized labels go "
                "to synonym/title/comment.\n\n" + content
            ),
            "source": "BAS_BUH/ConfigFiles/Configuration.xml",
            "title": "BAS configuration root pattern",
            "workspace_id": WORKSPACE,
            "metadata": {
                "namespace": NAMESPACE,
                "source_corpus": "bas-buh-business-patterns",
                "kind": "configuration-root",
                "artifact_kind": "configuration",
                "requires_english_identifiers": True,
                "labels_go_to_synonym": True,
            },
        })

    for dirname, kind in SUPPORTING_DIRS.items():
        root = cfg_root / dirname
        if not root.exists():
            continue
        for xml_path in sorted(root.glob("*.xml")):
            xml_root = parse_xml(xml_path)
            name = first_text(xml_root, "Name") or xml_path.stem
            synonym = synonym_text(xml_root)
            english_name = transliterate_identifier(name)
            related_module = root / xml_path.stem / "Ext" / "Module.bsl"
            module_text = read_text(related_module, max_artifact_chars) if related_module.exists() else ""
            prefix = {
                "common-module": "CommonModules contain shared services used by documents, reports, forms, rights, printing, posting and integration.",
                "role-rights": "Roles define object rights and access profiles; generated configurations must include practical roles and permissions.",
                "interface-subsystem": "Subsystems are the BAS navigation/interface model; generated configurations must wire documents, catalogs, reports and commands into user sections.",
                "common-command": "Common commands expose cross-object actions in interfaces and command bars.",
                "command-group": "Command groups organize navigation and command placement.",
                "report": "Reports provide operational and analytical output and must be connected to roles/interfaces.",
            }.get(kind, "Supporting BAS metadata pattern.")
            summary = [
                f"# BAS supporting pattern: {kind} {name}",
                prefix,
                f"Recommended OES technical name: {english_name}",
                "Technical identifiers in generated OES configs must be English ASCII; keep BAS/RU/UA names only as synonym/comment/title labels.",
                f"Synonym labels: {synonym or name}",
                f"Procedures: {', '.join(extract_procedures(module_text))}",
                "",
                "## Metadata XML",
                read_text(xml_path, max_artifact_chars),
            ]
            if module_text:
                summary += ["", "## Module", module_text]
            for idx, chunk in enumerate(chunk_text("\n".join(summary), max_artifact_chars)):
                records.append({
                    "content": chunk,
                    "source": f"BAS_BUH/ConfigFiles/{dirname}/{xml_path.stem}/{idx}",
                    "title": f"BAS {kind} pattern: {name}",
                    "workspace_id": WORKSPACE,
                    "metadata": {
                        "namespace": NAMESPACE,
                        "source_corpus": "bas-buh-business-patterns",
                        "kind": kind,
                        "artifact_kind": kind,
                        "bas_name": name,
                        "recommended_oes_name": english_name,
                        "chunk": idx,
                        "has_module": bool(module_text),
                        "procedures": extract_procedures(module_text),
                        "requires_english_identifiers": True,
                        "labels_go_to_synonym": True,
                    },
                })
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--max-artifact-chars", type=int, default=12000)
    args = parser.parse_args()

    records = build_records(args.source, args.max_artifact_chars)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    bundles = sum(1 for r in records if r["metadata"]["kind"] == "document-bundle")
    artifacts = len(records) - bundles
    print(f"wrote {len(records)} records: {bundles} bundles, {artifacts} artifact chunks")
    print(f"output: {args.out}")
    print(f"workspace_id: {WORKSPACE}")
    print(f"namespace: {NAMESPACE}")


if __name__ == "__main__":
    main()
