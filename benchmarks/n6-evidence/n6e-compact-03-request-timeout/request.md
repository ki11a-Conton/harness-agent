src/http.js hardcodes a request timeout that no longer matches the service level objective. Read spec/slo.txt to obtain the required timeout, then set it in src/http.js.
