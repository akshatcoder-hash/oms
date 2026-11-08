# Build context: .tmp/toolchain (verified release archives); see README.md.
FROM node@sha256:a174cf99ada4707fb5a81a9233af04db83911c68b6bf58199f956fbdf8389926
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates bzip2 xz-utils build-essential pkg-config libssl-dev libudev-dev python3 \
    && rm -rf /var/lib/apt/lists/*
COPY agave.tar.bz2 platform-tools.tar.bz2 anchor rustup-init /tmp/archives/
RUN cd /tmp/archives && printf '%s\n' \
    '5b0f0fc7e4eedace05f6455de00aa1f2f3d1642068f1e8d50760ba49112c3941  agave.tar.bz2' \
    '7b82eb420b5aebd1e5590db0ae25c523eca06724d4238ae02139690535636c37  platform-tools.tar.bz2' \
    'e2c35a973bcfe476f3a89b120e99820f917229faf33d3e71f6625bd94199e741  anchor' \
    '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  rustup-init' \
    | sha256sum -c - \
    && mkdir -p /opt/agave /opt/platform-tools /opt/anchor \
    && tar -xjf agave.tar.bz2 -C /opt/agave --strip-components=1 \
    && tar -xjf platform-tools.tar.bz2 -C /opt/platform-tools \
    && install -m755 anchor /opt/anchor/anchor-1.2.2 \
    && chmod +x rustup-init
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo RUSTUP_TOOLCHAIN=1.98.1
RUN /tmp/archives/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.1 \
    && chmod -R a+rX /opt/rustup /opt/cargo && rm -rf /tmp/archives
ENV PATH=/usr/local/bin:/opt/cargo/bin:/opt/agave/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    SOLANA_PLATFORM_TOOLS_DIR=/opt/platform-tools
COPY anchor-shim /usr/local/bin/anchor
COPY cargo-build-sbf-shim /usr/local/bin/cargo-build-sbf
RUN chmod 755 /usr/local/bin/anchor /usr/local/bin/cargo-build-sbf \
    && mkdir /opt/platform-tools/v1.58 && ln -s .. /opt/platform-tools/v1.58/platform-tools \
    && grep -F e974f036b28565f37c0f3bd92ddefa809bee16c04f9dcf07b9ed96e05aaaf7c4 /opt/rustup/toolchains/1.98.1-x86_64-unknown-linux-gnu/lib/rustlib/multirust-channel-manifest.toml >/dev/null \
    && grep -F ea1de9f9e23107d97ee2b41a72c552f34064a593da503789218387aee59f3ba4 /opt/rustup/toolchains/1.98.1-x86_64-unknown-linux-gnu/lib/rustlib/multirust-channel-manifest.toml >/dev/null \
    && grep -F fa3ff450172a16c026944030230c5069947af93c728d9179971d44e5e0cfb561 /opt/rustup/toolchains/1.98.1-x86_64-unknown-linux-gnu/lib/rustlib/multirust-channel-manifest.toml >/dev/null \
    && anchor --version && solana --version && rustc --version \
    && test ! -e /opt/cargo/bin/avm
