# GreptimeDB Tenant Benchmark

Benchmarks two multi-tenant storage strategies for GreptimeDB:

- **Strategy A** — one table per tenant (`spans_<uuid>`, `conversation_items_<uuid>`)
- **Strategy B** — shared tables with a `tenant_id` column, partitioned across datanodes

See [BENCHMARK.md](BENCHMARK.md) for the full design rationale, schema definitions, and decision criteria.

---

## EC2 instance recommendation

The docker-compose runs a full GreptimeDB cluster on a single host alongside the benchmark client. All resource limits are enforced via `mem_limit`/`cpus` on each container.

| Component | Instances | vCPU | Memory |
|---|---|---|---|
| datanode | 3 | 2 each | 8 GiB each |
| frontend | 2 | 2 each | 24 GiB each |
| postgres + metasrv + haproxy | — | ~1 | ~2 GiB |
| benchmark client (Bun) | — | ~2 | ~2 GiB |
| **Total** | | **~17 vCPU** | **~54 GiB** |

**Recommended**: `r6i.4xlarge` — 16 vCPU, 128 GiB RAM, EBS gp3 (~$1.01/hr on-demand).

EBS gp3 is intentionally used rather than NVMe instance storage. In production GreptimeDB stores SSTs in object storage (S3), so EBS latency characteristics are a closer approximation of real-world conditions than local NVMe.

**EBS volume** — size depends on which tenant-scale runs you intend to execute:

| Run | Tenants | `SPARSE_MULTIPLIER` | Compressed data | Volume needed |
|---|---|---|---|---|
| 100 tenants (baseline) | 100 | 1.0 | ~1.5 TB | 1500 GB |
| 1k tenants, full density | 1,000 | 1.0 | ~15 TB | 16000 GB |
| 10k tenants, sparse (0.2×) | 10,000 | 0.2 | ~3 TB | 3500 GB |
| 1k + 10k back-to-back | — | — | ~19.5 TB | 21000 GB |

Baseline: `1500 GB gp3`. For 1k or 10k runs provision accordingly before launch — EBS volumes can be extended live but only increased, not shrunk.

Increase provisioned IOPS/throughput (`--iops`, `--throughput`) if seeding bottlenecks on disk write; gp3 baseline (3000 IOPS / 125 MB/s) is usually sufficient for the 100-tenant run.

Minimum viable (smoke runs only): `r6i.2xlarge` — 8 vCPU, 64 GiB, 200 GB gp3.

---

## Setup

### 1. Launch the instance

```bash
AMI_ID=$(aws ec2 describe-images \
  --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023*-x86_64" \
            "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-1].ImageId" \
  --output text)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type r6i.4xlarge \
  --block-device-mappings '[{
    "DeviceName": "/dev/xvda",
    "Ebs": {"VolumeSize": 1500, "VolumeType": "gp3", "DeleteOnTermination": true}
  }]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=greptimedb-bench}]' \
  --query 'Instances[0].InstanceId' \
  --output text)

aws ec2 wait instance-running --instance-ids $INSTANCE_ID
```

### 2. Open SSH access

EC2 Instance Connect still connects over port 22 — open it on the default security group:

```bash
SG_ID=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' \
  --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0
```

### 3. Connect

EC2 Instance Connect pushes a temporary key using your AWS credentials — no key pair needed.

```bash
aws ec2-instance-connect ssh --instance-id $INSTANCE_ID --os-user ec2-user
```

All subsequent steps run **on the instance** over this session.

### 4. Install Docker

```bash
# Amazon Linux 2023 — installs Docker CE with compose plugin
sudo dnf install -y git tmux
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo sed -i 's/\$releasever/9/g' /etc/yum.repos.d/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
```

### 5. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

### 6. Clone the repo and install dependencies

```bash
git clone https://github.com/heiwen/greptime-tenant-benchmark.git greptime-tenant-benchmark
cd greptime-tenant-benchmark
bun install
```

---

## Running the benchmark

### Step 1 — Start the cluster

```bash
docker compose up -d

# Watch until all containers are running (takes ~30s)
watch docker compose ps
```

Wait until all 8 containers show `Up`. The startup order is enforced by `depends_on`:
postgres → metasrv → datanodes → frontends → haproxy.

Verify the cluster has registered all nodes:

```bash
curl -s -X POST http://localhost:4000/v1/sql \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "sql=SELECT peer_type, peer_addr, node_status FROM information_schema.cluster_info ORDER BY peer_type" \
  | jq '.output[0].records.rows'
```

Expect: 3 DATANODEs, 2 FRONTENDs, 1 METASRV. Each datanode should show `leader_regions > 0` after the first schema creation.

### Step 2 — Create schemas

`schema:create --strategy b` generates `results/tenants.json` (if not already present) and creates the 2 shared tables. Strategy A reads that file to create its per-tenant tables.

```bash
TENANT_COUNT=1000 bun run schema:create -- --strategy b
TENANT_COUNT=1000 bun run schema:create -- --strategy a
```

If `results/tenants.json` already exists from a previous run with a different tenant count, delete it first:

```bash
rm results/tenants.json
```

For the baseline 100-tenant run omit the env var (default is 100).

### Step 3 — Seed data

Full scale (~420 GB compressed, expect 3–6 hours with default 50-tenant concurrency):

```bash
tmux new -s seed
bun run seed -- --strategy b && bun run seed -- --strategy a
```

Detach so the seed keeps running after you disconnect: `Ctrl+B` then `D`.

Re-attach after reconnecting:

```bash
tmux attach -t seed
```

Scale is controlled by env vars (defaults shown):

| Variable | Default | Description |
|---|---|---|
| `TENANT_COUNT` | `100` | Number of tenants |
| `SPANS_PER_TENANT` | `500000` | Spans per tenant |
| `ITEMS_PER_TENANT` | `1000000` | Conversation items per tenant |
| `CONVERSATIONS_PER_TENANT` | `50000` | Distinct conversation IDs per tenant |
| `SEED_BATCH_SIZE` | `500` | Rows per INSERT for conversation items |
| `SPAN_BATCH_SIZE` | `100` | Spans per INSERT batch |
| `SEED_CONCURRENCY` | `50` | Tenants seeded in parallel (keep ≤ db pool size of 100) |
| `SPARSE_MULTIPLIER` | `1.0` | Scale data per tenant down proportionally for large tenant counts (e.g. `0.2` gives 100k spans/tenant) |

For a **smoke run** to verify everything works before committing to full seeding:

```bash
TENANT_COUNT=10 \
SPANS_PER_TENANT=5000 \
ITEMS_PER_TENANT=10000 \
CONVERSATIONS_PER_TENANT=500 \
bun run seed -- --strategy b

# then strategy a with the same vars
```

For the **1k-tenant run** (same per-tenant density, ~4 TB compressed):

```bash
TENANT_COUNT=1000 bun run seed -- --strategy b && TENANT_COUNT=1000 bun run seed -- --strategy a
```

For the **10k-tenant run** (reduced density so Q-time 1h returns ~50 rows, ~3.5 TB compressed):

```bash
TENANT_COUNT=10000 SPARSE_MULTIPLIER=0.2 bun run seed -- --strategy b
TENANT_COUNT=10000 SPARSE_MULTIPLIER=0.2 bun run seed -- --strategy a
```

### Step 4 — Run the benchmark

Run all scenarios for both strategies (the full matrix takes ~2.5 hours):

```bash
bun run bench
```

Run a specific subset by name (comma-separated):

```bash
bun run bench -- \
  --strategy both \
  --scenario w2-1vu,w2-10vu,w2-50vu,q-time-1h-10vu,q-time-24h-10vu,mixed-10vu
```

Skip the 60 s warm-up and Prometheus scraping for quick iteration:

```bash
bun run bench -- --no-warmup --skip-scrape
```

#### Available scenarios

| Name | Workload | VUs | Duration |
|---|---|---|---|
| `w2-1vu` | Span write | 1 | 2 min |
| `w2-10vu` | Span write | 10 | 2 min |
| `w2-50vu` | Span write | 50 | 2 min |
| `q-time-1h-10vu` | Time-range query, 1 h window | 10 | 2 min |
| `q-time-24h-10vu` | Time-range query, 24 h window | 10 | 2 min |
| `q-time-7d-10vu` | Time-range query, 7 d window | 10 | 2 min |
| `q-id-10vu` | Cursor pagination | 10 | 2 min |
| `w1-1vu` | Conversation item write | 1 | 2 min |
| `w1-10vu` | Conversation item write | 10 | 2 min |
| `w1-50vu` | Conversation item write | 50 | 2 min |
| `q-time-1h-10vu-s2` | Conversation time-range, 1 h | 10 | 2 min |
| `q-time-24h-10vu-s2` | Conversation time-range, 24 h | 10 | 2 min |
| `q-time-7d-10vu-s2` | Conversation time-range, 7 d | 10 | 2 min |
| `q-id-10vu-s2` | Conversation cursor pagination | 10 | 2 min |
| `q-conv-clustered-10vu` | Fetch full conversation history — single-session (items within ±48 h) | 10 | 2 min |
| `q-conv-scattered-10vu` | Fetch full conversation history — multi-session (items spread across 18 months) | 10 | 2 min |
| `m1-1tenant` | Memory pressure, 1 tenant | 50 | 5 min |
| `m2-5pct` | Memory pressure, 5% of tenants | 50 | 5 min |
| `m3-50pct` | Memory pressure, 50% of tenants | 50 | 5 min |
| `m4-50pct-b` | Memory pressure, 50% of tenants (B only) | 50 | 5 min |
| `mixed-10vu` | Mixed read/write | 10 | 15 min |
| `mixed-50vu` | Mixed read/write | 50 | 15 min |
| `mixed-100vu` | Mixed read/write | 100 | 15 min |

### Step 5 — Collect results

CSV files are written to `results/` after each run:

```
results/results-combined-<timestamp>.csv
```

Columns: `workload, strategy, scenario, vus, count, errors, p50_ms, p90_ms, p95_ms, p99_ms, qps, mbps`

Prometheus metrics (scraped every 5 s during memory-pressure runs unless `--skip-scrape`) are written alongside the CSV.

---

## Collecting logs

Run the benchmark via `tee` so stdout and stderr are captured to a file while the run is in progress:

```bash
bun run bench 2>&1 | tee bench-$(date +%Y%m%dT%H%M%S).log
```

After the benchmark, dump all container logs:

```bash
for svc in metasrv datanode0 datanode1 datanode2 frontend0 frontend1; do
  docker compose logs --no-color $svc > logs-$svc.txt
done
```

---

## CONV_PK comparison

`CONV_PK=true` adds `conversation_id` to the PRIMARY KEY of `conversation_items`, physically co-locating each conversation's items within SST files. This makes `q-conv-scattered` (multi-session conversations with items spread across 18 months) significantly faster at the cost of higher series cardinality (50k series/tenant instead of 1).

The `q-conv-clustered` scenario (single-session conversations) and all Q-time S2 queries are expected to be unaffected — the time-range pruning path is unchanged.

To isolate this variable, run both strategies at reduced scale (seeding takes ~10 minutes):

```bash
# Baseline — no PK
docker compose down -v && docker compose up -d
CONV_PK=false \
TENANT_COUNT=10 \
SPANS_PER_TENANT=5000 \
ITEMS_PER_TENANT=100000 \
CONVERSATIONS_PER_TENANT=5000 \
bun run schema:create -- --strategy b && bun run schema:create -- --strategy a
CONV_PK=false TENANT_COUNT=10 SPANS_PER_TENANT=5000 ITEMS_PER_TENANT=100000 CONVERSATIONS_PER_TENANT=5000 \
  bun run seed -- --strategy b
CONV_PK=false TENANT_COUNT=10 SPANS_PER_TENANT=5000 ITEMS_PER_TENANT=100000 CONVERSATIONS_PER_TENANT=5000 \
  bun run seed -- --strategy a
CONV_PK=false TENANT_COUNT=10 SPANS_PER_TENANT=5000 ITEMS_PER_TENANT=100000 CONVERSATIONS_PER_TENANT=5000 \
  bun run bench -- --scenario q-conv-clustered-10vu,q-conv-scattered-10vu,q-time-1h-10vu-s2,q-time-24h-10vu-s2 --no-warmup --skip-scrape

# With PK — repeat on a clean cluster
docker compose down -v && docker compose up -d
CONV_PK=true \
TENANT_COUNT=10 \
SPANS_PER_TENANT=5000 \
ITEMS_PER_TENANT=100000 \
CONVERSATIONS_PER_TENANT=5000 \
bun run schema:create -- --strategy b && bun run schema:create -- --strategy a
CONV_PK=true TENANT_COUNT=10 SPANS_PER_TENANT=5000 ITEMS_PER_TENANT=100000 CONVERSATIONS_PER_TENANT=5000 \
  bun run seed -- --strategy b
CONV_PK=true TENANT_COUNT=10 SPANS_PER_TENANT=5000 ITEMS_PER_TENANT=100000 CONVERSATIONS_PER_TENANT=5000 \
  bun run seed -- --strategy a
CONV_PK=true TENANT_COUNT=10 SPANS_PER_TENANT=5000 ITEMS_PER_TENANT=100000 CONVERSATIONS_PER_TENANT=5000 \
  bun run bench -- --scenario q-conv-clustered-10vu,q-conv-scattered-10vu,q-time-1h-10vu-s2,q-time-24h-10vu-s2 --no-warmup --skip-scrape
```

Key metrics to compare across the two runs:

| Scenario | Expected with `CONV_PK=true` |
|---|---|
| `q-conv-scattered` | Significantly faster (binary search within SST vs full scan) |
| `q-conv-clustered` | Similar (BLOOM index already effective for clustered data) |
| `q-time-1h-10vu-s2` | Similar (time-range pruning is unaffected by PK) |
| `q-time-24h-10vu-s2` | Similar |

---

## Teardown

On the instance — stop the cluster:

```bash
# Remove containers and volumes (destroys seeded data)
docker compose down -v

# Keep volumes if you want to re-run without re-seeding:
docker compose down
```

From your local machine (re-run the lookup if you've opened a new terminal):

```bash
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=greptimedb-bench" \
            "Name=instance-state-name,Values=running,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

# Stop — pauses compute billing, keeps EBS data (resume later with start)
aws ec2 stop-instances --instance-ids $INSTANCE_ID

# Start again
aws ec2 start-instances --instance-ids $INSTANCE_ID
aws ec2 wait instance-running --instance-ids $INSTANCE_ID

# Terminate — destroys instance and EBS volume, no further charges
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
```

Note: the public IP changes after a stop/start. Re-run the `describe-instances` command to get the new one.

---

## Environment variable reference

| Variable | Default | Description |
|---|---|---|
| `GREPTIMEDB_URL` | `postgres://greptime@localhost:4003/public` | Connection string (points at HAProxy) |
| `GREPTIMEDB_PROMETHEUS_URLS` | `http://localhost:15000/metrics,...` | Comma-separated datanode `/metrics` endpoints. Must be set to the server's IP if running the benchmark client from a different machine. |
| `TENANT_COUNT` | `100` | |
| `SPANS_PER_TENANT` | `500000` | |
| `ITEMS_PER_TENANT` | `1000000` | |
| `CONVERSATIONS_PER_TENANT` | `50000` | |
| `SEED_CONCURRENCY` | `50` | Tenants seeded in parallel |
| `SPARSE_MULTIPLIER` | `1.0` | Scale data per tenant proportionally |
| `CONV_PK` | `false` | Add `conversation_id` to the PRIMARY KEY of `conversation_items` tables. See [CONV_PK comparison](#conv_pk-comparison) below. |
| `RESULTS_DIR` | `./results` | Output directory for CSVs |
