---
title: JSONB Connector Design
summary: Why @grafctory/keep-jsonb stores resources as documents, what it needs from PostgreSQL and what it costs to run
description: |
  Design notes for the document-storage PostgreSQL connector tracked as grafctory/keep#31: where it sits beside the
  relational connector, what it relies on, how it compares with a triplestore, and what implementing it takes.
---

# Scope

PostgreSQL. The connector speaks SQL and the PostgreSQL wire protocol, so Cloud SQL, AlloyDB and a self-hosted instance
are the same target. Picking among them is a deployment decision taken later against cost, scale and operational
preference, and whichever way that decision goes the connector itself stays exactly as it is.

A connector translates a retrieval template into a backend query. It does not evaluate one. PostgreSQL executes every
QEST construct itself, and it accepts a new shape without DDL and an unforeseen filter and sort combination without a
predeclared index, which is the whole of what a connector needs from the engine underneath it.

# Entry Tier

This connector stores each resource as a document, and it is one of two SQL connectors rather than a rival to the
other. The table-based connector explored in issue #1 derives a relational schema from the shape instead: typed
columns for single-valued properties, child tables for multi-valued and localised ones, joined-table inheritance
over a shared entity. Both sit behind the same `Store` contract, so moving between them costs a configuration
change and a data migration, and never any rewriting of the application sitting above the store.

|                     | documents                    | tables, #1                                  |
|---------------------|------------------------------|---------------------------------------------|
| setup               | a connection string          | generated DDL, a migration per shape change |
| engines             | PostgreSQL                   | PostgreSQL, MySQL, SQL Server               |
| resource read       | one row                      | a join per level and per multi-valued field |
| faceted aggregation | wants the facet path indexed | reads one narrow column                     |
| outside tools       | opaque                       | readable by the customer's own reporting    |

Faceting is the one operation the document layout starts behind on, and it climbs back in steps. An expression
index over the facet path stores the extracted value, so a grouping over that path is answered from the index alone,
without reading or decompressing a single document. Where aggregation later becomes the dominant workload, promoting
the path to a stored generated column opens columnar storage to it, at the price of a table rewrite and of a
connector that has started managing columns again. Anything needing a step beyond those two has arrived at the
relational connector by another road, and the honest advice at that point is to take it rather than improvise.

The document connector is the entry tier, and its promise is that it asks for a connection string and nothing else:
no DDL privilege, no migration step, no schema provisioned ahead of the first write. That promise is its whole
identity, and the moment it grows a migration tool it has become the other connector with extra steps. Keeping
`pg_trgm` the only extension and the primary key the only mandatory index belongs to the same discipline.

Two things move a deployment up a tier, and both are known on the day a customer is sized: reporting tools that
have to read the data directly, and an estate standardised on MySQL or SQL Server. Plan quality is not a third,
since an expression index gives `ANALYZE` something to gather statistics on and `CREATE STATISTICS` covers
correlated paths without one, which leaves it demand-driven index work like any other.

# What the Connector Relies On

- **Storage**: a resource held whole as `jsonb`, written and read back in a single row
- **Property paths**: self-joins on the reference key, to any depth the template asks for
- **Transform pipes**: SQL functions over `jsonb` extractions, with no shadow columns to maintain
- **Substring search**: `ILIKE` for correctness, `pg_trgm` for an index when a collection grows enough to need one
- **Computed projections**: `GROUP BY`, which covers faceted retrieval without a second query engine
- **Union-typed sort keys**: `jsonb_typeof` for the type rank the total ordering needs
- **Ad-hoc indexing**: GIN and expression indexes, so no shape declares its indexes ahead of the queries it serves
- **Transactions**: read-committed by default, serializable on request
- **Mutation events**: logical decoding, available on managed offerings as well as self-hosted instances

# Dynamic Shapes

Shapes change at runtime without touching the database. The table layout is fixed and a shape lives inside the `jsonb`
body, so revising one needs no `ALTER TABLE`, no migration and no downtime, and the connector needs no DDL
privilege to keep working. That much is as schemaless as anything a document store offers.

Indexes are the part that lags, and they lag in speed rather than in correctness. A query that filters or sorts on a
property introduced an hour ago returns the right answer immediately, because PostgreSQL falls back to a scan when no
index covers the predicate. One GIN index over the body serves containment and key-existence for every property at
once, while range predicates, ordering and substring search each want an index on the specific path they touch.

Add those as measurements ask for them rather than in advance. `CREATE INDEX CONCURRENTLY` takes no write lock, so
an index lands on a live instance without an outage, and on a few gigabytes it builds in minutes, while
`pg_stat_statements` names the queries actually worth the disk and the write throughput an index costs. At the
scale this connector targets a scan across a cached few gigabytes runs in tens of milliseconds, so a deployment of
that size may never call for its first expression index, and nothing is lost by waiting to find out.

Leave the choice to a person. Which index earns its place follows from the whole query mix rather than from the query
in hand, which is precisely the judgement a connector creating indexes on its own would not be in a position to make.

# Compatible Backends

Anything running the PostgreSQL query engine works unchanged: Cloud SQL, RDS, Supabase, Neon, Timescale, Citus and a
self-hosted instance, along with AlloyDB and Aurora, which replace the storage underneath rather than the engine.

Backends that only speak the wire protocol have to be checked. CockroachDB, YugabyteDB and Spanner's PostgreSQL
dialect diverge precisely where the list above is most demanding: GIN over `jsonb`, expression indexes, `pg_trgm`
and logical decoding. Extensions are the sharpest edge of the four, since indexed substring search needs `pg_trgm`
and a reimplementation of PostgreSQL has no way of supplying an extension written against the real engine.

Settle each candidate by running `keep-suite` against it. Support is then a test result rather than a reading of
somebody's compatibility page, and it can be claimed per backend instead of claimed for a whole family at once.

# Against a Triplestore

Keep already reaches RDF stores through `keep-sparql`, so this compares two backends behind one API rather than two
products. QEST retrieval is resource-shaped, a row store holds a resource whole, and a triplestore decomposes it
and rejoins it on every read. Almost every row of the table below follows from that one difference.

| Operation                     | PostgreSQL | against a triplestore                               |
|-------------------------------|------------|-----------------------------------------------------|
| resource lookup               | ahead      | one row against a subject's triples reassembled     |
| collection filter, sort, page | well ahead | fifty row fetches against a thousand triple lookups |
| bounded property paths        | parity     | a self-join per hop against a pattern per hop       |
| transitive paths              | behind     | a recursive walk against a closure operator         |
| faceted aggregation           | ahead      | a hash aggregate rather than a join then grouping   |
| substring search              | ahead      | `pg_trgm` against a text connector to wire up       |
| writes                        | ahead      | one row updated against triples reindexed           |

Treat the transitive row as a noted limit rather than a risk. What drives the feature is a concept scheme walked
upwards or downwards, rarely as deep as ten levels and narrow in fan-out, where every level costs one index lookup.
Deep closure over dense reachability graphs is a different workload, and not one a retrieval template expresses.

Footprint favours rows as well. A triplestore maintains several index permutations of the same statements, so a
graph that PostgreSQL fits into the figures below needs a larger instance to hold, and the licence it usually
carries has no counterpart in those figures either, which widens the gap further at every size.

None of this is measured. Running the `keep-suite` query set against both backends over a single dataset would
turn the table above into evidence rather than the structural expectation it currently records.

# Implementation

The planner, the spine and the pass drivers carry over as they stand, being shape-driven or language-neutral. What
gets rewritten is the emitters and the clause assembly of each pass, which is precisely the split that the
five-layer architecture of the existing connector was drawn in order to make cheap to cross.

The collection encoder is where the effort drops rather than moves. Most of the largest file in `keep-sparql`
compensates for the absence of window functions: a windowed plan over several owners runs one arm per owner, under
an outer query restating the ordering across their union. SQL says that in one `row_number() over (partition by …)`,
and an aggregate over an empty collection falls out of a `left join` with `coalesce` instead of optional bindings
nested under subselects. Decoding shrinks for the same reason retrieval does, since a resource arrives as a
single document rather than as a spread of rows waiting to be gathered back into one.

Three design issues stay open:

- **Link storage**: references held inline in the document, or kept in an edge table of their own. The choice
  settles how a property path lowers to joins, and what shape the recursive form of a transitive step takes.
- **Union variant ranks**: shapes carry the expected type of every property, so stored values need no type tag and
  the decoder reads each one through the shape it belongs to. A union-typed sort key is the exception, because the
  total ordering ranks by native type inside SQL where no shape is at hand, and `jsonb_typeof` separates string from
  number and boolean while seeing one JSON string for both a temporal value and a plain one.
- **Localised text**: a shape marks a property localised, so an object of tag against text carries it without
  further annotation. What needs settling is the tag-priority lookup, in those clauses that filter, sort or
  project on a label rather than merely returning it to the caller for display untouched.

# Cost

Sized on a graph like the EC2U one, which carries a few million edges and serves a handful of users. A graph that size
is a few gigabytes on disk and fits entirely in the instance cache, so the bill is the instance floor and nothing
else, and doubling the edge count would leave that bill exactly where it stands today.

Cloud SQL Enterprise in `europe-west1`, zonal, no high availability, no commitment:

| Instance                             | Size  | vCPU | RAM | Disk | Total [$/m] |
|--------------------------------------|-------|------|-----|------|-------------|
| 1 vCPU / 3.75 GB, stopped off-hours  | 10 GB | $7   | $5  | $1   | **$13**     |
| 1 vCPU / 3.75 GB                     | 20 GB | $30  | $19 | $2   | **$52**     |
| 2 vCPU / 8 GB                        | 50 GB | $60  | $41 | $6   | **$107**    |

Start at 1 vCPU and move up only if query latency says so. Nothing here argues for high availability, which doubles
the bill, or for a committed use discount, which locks in a full year of spending on a deployment that may well
not outlive the commitment that was bought in order to make its running costs a little lower.

The first two rows are the same machine, sized at the Cloud SQL floor: a one-vCPU instance requires 3840 MB of
memory, so 3.75 GiB is as small as an instance gets. The first row is a development environment, and its saving comes
entirely from stopping the instance outside working hours, since Cloud SQL charges compute only while an instance
runs: eight hours a day across twenty-two working days bills 176 hours rather than 730, and the stopped hours cost
only the disk. Cheaper still is to skip the instance altogether, since a development database on the prototype
instance costs nothing extra and a container on a workstation costs nothing whatsoever.

Rates read from the Cloud Billing Catalog on 28 November 2026: $0.0413 per vCPU-hour, $0.007 per GiB-hour of memory,
and $0.115 per GiB-month of zonal Hyperdisk Balanced. Cloud SQL compute in Belgium is priced exactly as it is in
Iowa, so hosting in Europe costs nothing extra at this size, nor at any size above it.

# Stores per Instance

One instance hosts as many databases as wanted, and the floor above is charged per instance rather than per database.
Several stores, with their development and staging copies, therefore share one bill instead of multiplying it.

What they share also limits them. CPU, memory and disk are pooled, so carving an instance up does not add capacity to
it. Connections bind first: `max_connections` is derived from instance memory, which leaves the smaller tiers a modest
budget that every database draws on at once. PostgreSQL also forbids queries across databases, which is harmless
for self-contained stores but does make a database a boundary that nothing reaches over.

Prefer one database with a schema per store. The isolation of names and permissions is the same, the connection pool
is shared rather than divided, and queries across stores stay possible. Reach for a separate database only where a
store needs to be backed up, restored or dropped on its own, independently of everything beside it.

# Once the Prototype Grows

- **AlloyDB**: same connector, no code change. Its primary is highly available by default, so at around $267 a month
  it undercuts Cloud SQL with HA. Whether its columnar engine reaches a `jsonb` path at all, or wants a generated
  column put in front of it first, needs checking before anyone counts it as the answer to heavy faceting
- **Spanner**: a separate connector. It covers the same constructs and adds horizontal scale, external consistency and
  change streams, but its JSON functions, dialect and index model need an emitter of their own
