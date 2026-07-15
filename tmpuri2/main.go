package main
import ("encoding/json";"fmt";"os";"github.com/MMWOrg/mmwX-plugins/proxyparser")
func main(){
  uri := "socks://amltbGVlOkchdkBxNVBWWEtqJkllZjE=@us-a.2ha.me:34670#%F0%9F%87%BA%F0%9F%87%B8%20test"
  ps, err := proxyparser.ParseSubscription(uri)
  if err != nil { fmt.Println("parse err:", err); os.Exit(1) }
  if len(ps)==0 { fmt.Println("no proxies"); os.Exit(1) }
  b,_ := json.MarshalIndent(map[string]any(ps[0]),"","  "); fmt.Println(string(b))
}
