////////////////////////////////////////////////////////////////////////////
//	Description : PostgreSQL static dialect descriptors — split out of the
//	              driver so they compile on every platform.
//
//	ibDatabaseLayerPostgres::Dialect() / TempDialect() are pure data (no
//	libpq, no PGconn, no instance) but they used to live in
//	postgresDatabaseLayer.cpp, which the CMake build excludes whenever
//	OES_USE_POSTGRESQL is off (the default on macOS/Firebird builds). That
//	left the query-renderer test suites — which use the postgres dialect as a
//	representative target — unable to link off-Windows.
//
//	This TU sits one directory above postgres/, so the build's
//	"databaseLayer/postgres/*" exclusion never touches it: the dialect data is
//	always compiled, while the rest of the driver (connection, libpq glue)
//	stays behind OES_USE_POSTGRESQL. The header is libpq-free, so including it
//	here pulls no platform dependency.
////////////////////////////////////////////////////////////////////////////

#include "backend/databaseLayer/postgres/postgresDatabaseLayer.h"

const ibDialectDictionary& ibDatabaseLayerPostgres::Dialect()
{
	static const ibDialectDictionary s_dialect = [] {
		ibDialectDictionary d;
		d.m_paramStyle = ibParamStyle::DollarN;       // $1, $2, ...
		d.m_pagination = ibPagination::LimitOffset;
		d.m_boolForm   = ibBoolForm::TrueFalse;
		d.m_features.m_window        = true;
		d.m_features.m_cte           = true;
		d.m_features.m_fullOuterJoin = true;
		d.m_features.m_iLike         = true;
		d.m_features.m_rollup        = true;   // GROUP BY ROLLUP(...) — standard spelling
		// type map
		d.m_typeBoolean       = wxT("BOOLEAN");
		d.m_typeDate          = wxT("TIMESTAMP");
		d.m_typeBlob          = wxT("BYTEA");
		d.m_typeGuid          = wxT("UUID");
		d.m_typeNumberPattern = wxT("NUMERIC(%d,%d)");
		return d;
	}();
	return s_dialect;
}

const ibTempTableDialect& ibDatabaseLayerPostgres::TempDialect()
{
	static const ibTempTableDialect s_temp = [] {
		ibTempTableDialect t;
		t.m_strategy      = ibTempTableDialect::Strategy::AdHocCreate;
		t.m_createPrefix  = wxT("CREATE TEMPORARY TABLE");
		t.m_onCommitClause = wxEmptyString;     // session-scoped; the manager drops it explicitly
		t.m_autoDrops     = false;              // explicit DROP via the pinning scope (RAII, leak-free)
		t.m_dropPrefix    = wxT("DROP TABLE");
		return t;
	}();
	return s_temp;
}
