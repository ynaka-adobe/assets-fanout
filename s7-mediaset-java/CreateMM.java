import com.scene7.api.webserviceclient.*;

// Create a Mixed Media Set (subType=MediaSet). Correct member format:
//   ${getCatalogId([H])};${getCatalogId([H])};<type>;   comma-joined
// args: server user pass company folderHandle name imgHandles(comma) vidHandles(comma)
public class CreateMM {
    static String member(String h, String type){
        return "${getCatalogId(["+h.trim()+"])};${getCatalogId(["+h.trim()+"])};"+type+";";
    }
    public static void main(String[] args) throws Exception {
        String server=args[0], user=args[1], pass=args[2], company=args[3];
        String folderHandle=args[4], name=args[5];
        String imgs = args.length>6 ? args[6] : "";
        String vids = args.length>7 ? args[7] : "";

        java.util.List<String> parts = new java.util.ArrayList<>();
        if (!imgs.isEmpty()) for (String h: imgs.split(",")) if(!h.isBlank()) parts.add(member(h,"advanced_image"));
        if (!vids.isEmpty()) for (String h: vids.split(",")) if(!h.isBlank()) parts.add(member(h,"video"));
        String def = String.join(",", parts);

        IpsApiServiceStub stub = new IpsApiServiceStub(server.endsWith("/")?server:server+"/");
        AuthHeader auth = new AuthHeader();
        auth.setUser(user); auth.setPassword(pass);
        auth.setAppName("fanout-demo"); auth.setAppVersion("1.0.0");

        CreateAssetSetParam p = new CreateAssetSetParam();
        p.setCompanyHandle(company);
        p.setFolderHandle(folderHandle);
        p.setName(name);
        p.setSubType("MediaSet");
        p.setSetDefinition(def);

        System.out.println("Creating MediaSet '"+name+"'");
        System.out.println("  setDefinition="+def);
        try {
            CreateAssetSetReturn r = stub.createAssetSet(p, auth);
            System.out.println("CREATED assetHandle="+r.getAssetHandle());
        } catch (IpsApiFaultException e){
            IpsApiFault f=e.getFaultMessage();
            System.out.println("FAULT code="+(f!=null?f.getCode():"?")+" reason="+(f!=null?f.getReason():e.getMessage()));
        }
    }
}
