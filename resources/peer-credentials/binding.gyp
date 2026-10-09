{
  "targets": [
    {
      "target_name": "stellar_peer_credentials",
      "sources": ["src/peer_credentials.cc"],
      "defines": ["NAPI_VERSION=8", "_GNU_SOURCE"],
      "conditions": [
        ["OS=='mac'", {"defines": ["DARWIN"]}],
        ["OS=='win'", {"defines": ["WINDOWS"]}]
      ]
    }
  ]
}
