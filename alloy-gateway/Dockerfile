FROM grafana/alloy@sha256:491b0578c04983fd54fe99b587b6fab4404dc46d0dc16677bd6b00cc1140b308 AS alloy
FROM nginx@sha256:8adbdcb969e2676478ee2c7ad333956f0c8e0e4c5a7463f4611d7a2e7a7ff5dc

COPY --from=alloy /bin/alloy /usr/local/bin/alloy
COPY config.alloy /etc/alloy/config.alloy
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh

RUN chmod 0555 /entrypoint.sh /usr/local/bin/alloy

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD test -d "/proc/$(cat /tmp/alloy.pid)" && nginx -t
ENTRYPOINT ["/entrypoint.sh"]
