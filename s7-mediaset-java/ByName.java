import com.scene7.api.webserviceclient.*;

// Look up assets by name. args: server user pass company name[,name...]
public class ByName {
    public static void main(String[] args) throws Exception {
        String server=args[0], user=args[1], pass=args[2], company=args[3];
        String[] names = args[4].split(",");
        IpsApiServiceStub stub = new IpsApiServiceStub(server.endsWith("/")?server:server+"/");
        AuthHeader auth = new AuthHeader();
        auth.setUser(user); auth.setPassword(pass);
        auth.setAppName("fanout-demo"); auth.setAppVersion("1.0.0");
        StringArray na = new StringArray(); na.setItems(names);
        GetAssetsByNameParam p = new GetAssetsByNameParam();
        p.setCompanyHandle(company); p.setNameArray(na);
        GetAssetsByNameReturn r = stub.getAssetsByName(p, auth);
        if (r.getAssetArray()==null || r.getAssetArray().getItems()==null){ System.out.println("(none)"); return; }
        for (Asset a : r.getAssetArray().getItems()){
            AssetSetInfo si = a.getAssetSetInfo();
            System.out.println("name="+a.getName()+" type="+a.getType()+" subType="+a.getSubType()+" handle="+a.getAssetHandle()+" folder="+a.getFolder());
            System.out.println("  setDefinition="+(si==null?"(null)":si.getSetDefinition()));
        }
    }
}
