import { requiresUiContext, UI_CONTEXT_HEADER, UI_CONTEXT_ERROR_HEADER } from "./shared";

export function uiContextBootstrap(context: string | null, siteId: string | null = null) {
  // Only an opaque fixed-alphabet fingerprint is serialized, not names, roles,
  // session cookies, authenticator material or source/customer data.
  return `(()=>{
    const siteId=${JSON.stringify(siteId)}, context=${JSON.stringify(context)}, header=${JSON.stringify(UI_CONTEXT_HEADER)}, errorHeader=${JSON.stringify(UI_CONTEXT_ERROR_HEADER)};
    const requiresContext=${requiresUiContext.toString()};
    const previous=window.__temcoUiContextV1;
    if(previous){if(previous.context!==context||previous.siteId!==siteId)previous.block();return;}
    let blocked=false,message="The signed-in person or session changed. Reload to open the current sign-in. Pending actions were not replayed.";
    const block=(text)=>{if(blocked)return;blocked=true;if(text)message=text;window.dispatchEvent(new CustomEvent("temco-ui-context-blocked"));};
    Object.defineProperty(window,"__temcoUiContextV1",{value:Object.freeze({context,siteId,get blocked(){return blocked;},get message(){return message;},block}),writable:false});
    const original=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(input instanceof Request?input.url:String(input),window.location.href);
      const method=init&&init.method||(input instanceof Request?input.method:"GET");
      if(url.origin!==window.location.origin)return original(input,init);
      const scoped=true; // Includes Next RSC/page navigation, keeping persistent layouts and tool data on the same site.
      if(scoped&&siteId){const scopedHeaders=new Headers(init?.headers||(input instanceof Request?input.headers:undefined));scopedHeaders.set("X-Temco-Site",siteId);init={...init,headers:scopedHeaders};}
      if(!requiresContext(method,url.pathname))return original(input,init);
      if(blocked)return new Response(JSON.stringify({error:message,code:"ui_context_changed"}),{status:409,headers:{"Content-Type":"application/json",[errorHeader]:"changed","Cache-Control":"no-store"}});
      const request=new Request(input,init),headers=new Headers(request.headers);
      headers.set(header,context||"anonymous");
      const response=await original(new Request(request,{headers,cache:"no-store"}));
      if(response.headers.has(errorHeader))block();
      return response;
    };
  })();`;
}
