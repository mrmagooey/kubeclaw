-- envoy-substitution-filter.lua
-- Reads x-kubeclaw-substitutions and x-kubeclaw-policy headers emitted by the
-- credential-broker ext_authz step; replaces placeholder strings inline in request
-- headers and body; enforces substitution-policy limits; strips both headers before
-- upstream send.
--
-- Wire format (avoids JSON/base64 library requirements in Envoy Lua):
--   x-kubeclaw-substitutions: <placeholder1>=<b64value1>;<placeholder2>=<b64value2>;...
--   x-kubeclaw-policy: positions=header,body;per=10;total=50
--
-- Values are base64-encoded so they can contain any character safely in an
-- HTTP header value.

-- ── Minimal base64 decoder ────────────────────────────────────────────────────
local b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

local function base64_decode(s)
  -- Strip whitespace and padding
  s = s:gsub('%s', ''):gsub('=+$', '')
  local result = {}
  local buf = 0
  local bits = 0
  for i = 1, #s do
    local c = s:sub(i, i)
    local idx = b64chars:find(c, 1, true)
    if not idx then
      return nil, 'invalid base64 character: ' .. c
    end
    buf = buf * 64 + (idx - 1)
    bits = bits + 6
    if bits >= 8 then
      bits = bits - 8
      result[#result + 1] = string.char(math.floor(buf / (2 ^ bits)) % 256)
      buf = buf % (2 ^ bits)
    end
  end
  return table.concat(result)
end

-- ── Content-Type binary check ─────────────────────────────────────────────────
local function is_binary_content_type(ctype)
  if not ctype then return false end
  local lower = ctype:lower()
  if lower:find('^application/octet%-stream') then return true end
  if lower:find('^image/') then return true end
  if lower:find('^audio/') then return true end
  if lower:find('^video/') then return true end
  return false
end

local MAX_BODY_BYTES = 1024 * 1024  -- 1 MB

-- ── Main filter ───────────────────────────────────────────────────────────────
-- Body access lives in envoy_on_request_body, not envoy_on_request, because
-- request_handle:body() returns nil when called from envoy_on_request even
-- with an upstream buffer filter — the body hasn't been delivered to Lua's
-- callback yet at the headers phase. envoy_on_request_body fires after the
-- full body is buffered (end_stream=true), at which point headers + body are
-- both available and the request hasn't been forwarded upstream yet.
function envoy_on_request_body(request_handle, end_stream)
  -- Body may arrive in chunks; only process once the full body is buffered.
  if not end_stream then return end

  local hdrs = request_handle:headers()

  -- Read and immediately strip both kubeclaw headers
  local subs_hdr  = hdrs:get('x-kubeclaw-substitutions')
  local policy_hdr = hdrs:get('x-kubeclaw-policy')
  hdrs:remove('x-kubeclaw-substitutions')
  hdrs:remove('x-kubeclaw-policy')

  if not subs_hdr or subs_hdr == '' then return end

  -- ── Parse policy header ───────────────────────────────────────────────────
  local per_placeholder_max = 10
  local total_max = 50
  local allow_header = true
  local allow_body = true

  if policy_hdr and policy_hdr ~= '' then
    -- positions=header,body;per=10;total=50
    local positions_str = policy_hdr:match('positions=([^;]*)')
    if positions_str then
      allow_header = positions_str:find('header') ~= nil
      allow_body   = positions_str:find('body')   ~= nil
    end
    local per_str = policy_hdr:match('per=(%d+)')
    if per_str then per_placeholder_max = tonumber(per_str) end
    local total_str = policy_hdr:match('total=(%d+)')
    if total_str then total_max = tonumber(total_str) end
  end

  -- ── Parse substitutions header ────────────────────────────────────────────
  -- Format: placeholder1=b64value1;placeholder2=b64value2;...
  -- Placeholder names are plain ASCII (KC_PH_*), values are base64.
  local substitutions = {}
  for entry in (subs_hdr .. ';'):gmatch('([^;]+);') do
    local eq = entry:find('=', 1, true)
    if eq then
      local placeholder = entry:sub(1, eq - 1)
      local b64_value   = entry:sub(eq + 1)
      local value, err  = base64_decode(b64_value)
      if value then
        substitutions[#substitutions + 1] = { placeholder = placeholder, value = value }
      else
        request_handle:logWarn('kubeclaw-lua: base64 decode failed for placeholder ' .. placeholder .. ': ' .. (err or '?'))
      end
    end
  end

  if #substitutions == 0 then return end

  -- ── Counters ──────────────────────────────────────────────────────────────
  local counts = {}
  local total = 0

  local function apply_sub(text, placeholder, value)
    local new_text, n = text:gsub(placeholder:gsub('[%(%)%.%%%+%-%*%?%[%^%$]', '%%%1'), value)
    counts[placeholder] = (counts[placeholder] or 0) + n
    total = total + n
    if counts[placeholder] > per_placeholder_max or total > total_max then
      return nil, 'limit_exceeded'
    end
    return new_text, nil
  end

  -- ── Header substitution ───────────────────────────────────────────────────
  if allow_header then
    -- Collect headers into a table first (cannot mutate during pairs() iteration)
    local header_pairs = {}
    for name, value in hdrs:pairs() do
      header_pairs[#header_pairs + 1] = { name = name, value = value }
    end

    for _, sub in ipairs(substitutions) do
      for _, hp in ipairs(header_pairs) do
        if hp.value:find(sub.placeholder, 1, true) then
          local new_val, err = apply_sub(hp.value, sub.placeholder, sub.value)
          if err then
            request_handle:respond({ [':status'] = '503' }, 'substitution_limit_exceeded')
            return
          end
          hp.value = new_val
          hdrs:replace(hp.name, new_val)
        end
      end
    end
  end

  -- ── Body substitution ─────────────────────────────────────────────────────
  if allow_body then
    local ctype = hdrs:get('content-type') or ''
    if not is_binary_content_type(ctype) then
      local body = request_handle:body()
      if body then
        local body_len = body:length()
        if body_len <= MAX_BODY_BYTES then
          local body_text = body:getBytes(0, body_len)
          local new_body = body_text
          for _, sub in ipairs(substitutions) do
            if new_body:find(sub.placeholder, 1, true) then
              local replaced, err = apply_sub(new_body, sub.placeholder, sub.value)
              if err then
                request_handle:respond({ [':status'] = '503' }, 'substitution_limit_exceeded')
                return
              end
              new_body = replaced
            end
          end
          if new_body ~= body_text then
            body:setBytes(new_body)
          end
        end
      end
    end
  end
end
