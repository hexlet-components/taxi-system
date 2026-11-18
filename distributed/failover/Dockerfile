FROM postgres:18.7-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv curl \
    && python3 -m venv /opt/patroni \
    && /opt/patroni/bin/pip install --no-cache-dir 'patroni[etcd3,psycopg3]==4.1.5' \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/patroni/bin:${PATH}"
USER postgres
ENTRYPOINT ["patroni"]
