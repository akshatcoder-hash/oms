# Build from this host's local toolchain image ID (scripts/build-review-tools.sh),
# never an unpinned mutable tag.
ARG TOOLCHAIN_IMAGE
FROM ${TOOLCHAIN_IMAGE} AS build
RUN cargo install cargo-audit --version 0.22.2 --locked --root /review-tools
COPY tools/oms-sast /build/oms-sast
RUN cargo build --locked --release --manifest-path /build/oms-sast/Cargo.toml

FROM node@sha256:a174cf99ada4707fb5a81a9233af04db83911c68b6bf58199f956fbdf8389926
COPY --from=build /review-tools/bin/cargo-audit /usr/local/bin/cargo-audit
COPY --from=build /build/oms-sast/target/release/oms-sast /usr/local/bin/oms-sast
COPY .tmp/review-tools/advisory-db.tar /tmp/advisory-db.tar
RUN echo '71dfac691f8435115ca2381f1b3d13b6dfd8bd1861d75c8e2c9852376a9e6976  /tmp/advisory-db.tar' | sha256sum -c - \
    && mkdir /opt/advisory-db && tar -xf /tmp/advisory-db.tar -C /opt/advisory-db \
    && rm /tmp/advisory-db.tar
USER 65534:65534
WORKDIR /work
