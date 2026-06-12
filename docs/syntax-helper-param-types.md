# Syntax-helper: typed parameters for metadata reference types

Status: **design + entry point. NOT implemented. NOT GUI-tested.** Hand-off branch
`feature/syntax-helper-param-types` off `develop` (`ec23ee2c`).

## The actual gap (traced, not guessed)

Member completion (`Справочник.` → methods/attributes) is **already fully
implemented** in `develop` and works for every case that the precompile
interpreter can resolve to a concrete `ibValue`:

| You type | Resolves because |
|---|---|
| `Справочники.` | `globalContextManager.cpp:18` enumerates all catalogs into an `ibValueStructure` |
| `Справочники.Контрагенты.` | `catalogManager.cpp:34` `FillManagerMethods` — CreateElement/Select/FindByCode/… |
| `Объект.` after `Объект = Справочники.X.СоздатьЭлемент()` | `GetCurrentIdentifier` **executes** the method live (`CallAsFunc` + `SetVariable`), so the local carries the real object value |
| ссылка/объект `.` | `reference.cpp` `FillMembers` — methods + **configured attributes + tabular sections** |

The interpreter resolves chains by *actually running* the methods at edit time.
So anything reachable through an assignment or a chain already completes.

**The one case it cannot resolve: an untyped procedure/function parameter.**

```
Процедура Печать(Контрагент)   // <-- Контрагент has no value to execute, no type
    Контрагент.                // <-- completion shows nothing
КонецПроцедуры
```

There is no assignment to execute and the language has no implicit parameter
types, so the precompile variable for `Контрагент` is an empty `ibValue` →
`AddKeywordFromObject` has no methods/props to emit.

## What already exists (do not re-discover)

Parameter parsing **already supports typing** —
`codeEditorInterpreter.cpp:1006`:

```cpp
if (IsTypeVar())          // is the next token a known type?
    type = GetTypeVar();  // consume it
...
wxString realName = ExpectIdentifier(true);   // Тип Имя  form
...
if (!type.IsEmpty())
    valObject = ibValue::CreateObject(type);   // seed the param object
m_activeContext->AddVariable(realName, type, false, false, valObject);
```

So `Процедура Печать(Число Сумма)` already types `Сумма` and completes `.`.

The gate is `IsTypeVar` / `GetTypeVar` (`codeEditorInterpreter.cpp:1937` /
`:1952`). Both recognize **primitives only**:

```cpp
ibValue::IsRegisterCtor(lex.m_strData, ibCtorObjectType::ibCtorObjectType_object_primitive)
```

Metadata reference types (catalog/document refs) live in a **separate**
per-config registry on `ibMetaData` (`GetTypeCtor` / `GetAvailableCtor` /
`GetListCtorsByType`), not the global `ibValue` primitive registry. They are
never recognized → never seed a param object.

## Blast radius — why the naive fix is wrong

`IsTypeVar` / `GetTypeVar` are called in **6** places (decls, params, casts):
lines 887, 1006, 1096, 1197, 2012, 2385.

Recognizing **bare** metadata names (`Контрагенты`) as types **breaks normal
code**. In a param list `(Контрагенты)` meant as an untyped parameter:
`IsTypeVar("Контрагенты")` → true → `type = Контрагенты` → `ExpectIdentifier`
then tries to read the *name* and consumes `)`. The declaration mis-parses and
completion for the whole function dies. A catalog name and a variable name share
one namespace, so bare-name recognition is ambiguous by construction.

## Safe design — unambiguous dotted type tokens only

Recognize **only** the 1С-style dotted form, which can never appear as a plain
identifier in a declaration position:

```
Процедура Печать(СправочникСсылка.Контрагенты Контрагент)
    Контрагент.   // -> IsEmpty/GetObject/GetMetadata + configured attributes
КонецПроцедуры
```

Type prefixes (one per metadata kind): `СправочникСсылка` / `ДокументСсылка` /
`ПеречислениеСсылка` / `БизнесПроцессСсылка` … (mirror the existing
`type`-keyword completion list in `codeEditorLoader.cpp` `LoadFromKeyWord`,
which already enumerates `metaData->GetListCtorsByType(ibCtorObjectMetaType_Reference)`).

Properties of this form:
- Three lexems (`ident . ident`) — `GetTypeVar` currently reads **one**
  (`ExpectLexem`), so this needs multi-lexem look-ahead.
- The leading dot-prefix is a reserved type word, never a user identifier in a
  decl slot → zero collision with existing code → no blast radius.

## Implementation sketch

1. `IsTypeVar()` (no-arg, look-ahead variant): if the next lexem is a known
   metadata type-prefix **and** `PreviewGetLexem(+1)` is `.` and `+2` is an
   identifier, return true. Leave the primitive path untouched.
2. `GetTypeVar()`: when the prefix matches, consume `prefix . Name`, resolve the
   metadata ctor via the active `metaData` (reachable the same way as
   `codeEditorInterpreter.cpp:99` `metaData->GetCompileCache()`), and return a
   canonical type key.
3. Param seed (`:1043`): when the type is a metadata key, build the empty value
   from the **metaData** ctor (`metaData->GetTypeCtor(name)->CreateObject()` /
   `metaData->GetAvailableCtor(className)`), not `ibValue::CreateObject` (global
   registry — primitives only). Reuse the empty-ref path
   (`ibValueReferenceDataObject::Create(metaObject)`), which `FillMembers`
   already populates with attributes + methods (no DB needed).
4. Keep the existing `try/catch` around object creation — unknown/edge type →
   empty value → **current behavior** (graceful, no crash).

Where to get `metaData` inside `GetTypeVar`: the interpreter already obtains it
locally at lines 99 / 319 / 863. Lift it to a member or a small accessor so the
type path can reach the per-config ctor registry.

## Test plan (must run in the Designer — no headless path)

These value classes deref a live `metaObject` (`FillMembers`/`FillPredefined`,
`commonObject.cpp:1298` / `:1396`), so they crash on an empty construct — unlike
the session-less query values in `test_queryValueMembers.cpp`. There is no
in-memory metadata fixture (`test_queryComposer.cpp` uses mock `ibBackendQueryable`,
not a real catalog). So this **must** be verified in `build/bin/Release/designer.app`
against a config with a catalog:

1. `Процедура П(СправочникСсылка.<Cat> Об)` → `Об.` → expect IsEmpty/GetObject +
   the catalog's configured attributes.
2. `Процедура П(Контрагент)` (untyped) → must still parse; `Контрагент.` empty
   (unchanged). Regression check that the dotted-form change didn't touch the
   bare-name path.
3. `Число Сумма` param → `Сумма.` → primitive methods still work (no regression).
4. Type-cast `СправочникСсылка.<Cat>(expr)` at a call site (line 2385 path) —
   confirm it doesn't mis-fire.

## Open questions for the owner

- Exact reserved type-prefix spelling per metadata kind (ru/uk/en) — align with
  the `type`-keyword completion strings already shown in the editor.
- Should typed **locals** (`СправочникСсылка.X Об;`) and **type-casts** get the
  same treatment in this pass, or params only? (Lifting recognition into
  `IsTypeVar` enables all six call sites at once — wider value, wider testing.)
