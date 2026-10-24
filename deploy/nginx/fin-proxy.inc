# 公共代理参数（被 fin-terminal.conf include）

proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection        "";

# 冷启动抓取可能耗时数十秒，超时给足，避免 504 打断
proxy_connect_timeout 10s;
proxy_send_timeout    180s;
proxy_read_timeout    180s;

# 大 JSON 响应不落盘缓冲，边收边发
proxy_buffering on;
proxy_buffer_size 16k;
proxy_buffers 16 16k;

# SSE / 流式接口（如有）不被缓冲
proxy_cache off;
chunked_transfer_encoding on;
