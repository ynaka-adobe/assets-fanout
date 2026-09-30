import com.scene7.api.webserviceclient.*;

// Read one or more sets' definitions. args: server user pass companyHandle handle[,handle...]
public class GetSetDef {
    public static void main(String[] args) throws Exception {
        String server = args[0], user = args[1], pass = args[2], company = args[3];
        String[] handles = args[4].split(",");

        IpsApiServiceStub stub = new IpsApiServiceStub(server.endsWith("/") ? server : server + "/");
        AuthHeader auth = new AuthHeader();
        auth.setUser(user); auth.setPassword(pass);
        auth.setAppName("fanout-demo"); auth.setAppVersion("1.0.0");

        HandleArray ha = new HandleArray();
        ha.setItems(handles);
        GetAssetsParam p = new GetAssetsParam();
        p.setCompanyHandle(company);
        p.setAssetHandleArray(ha);

        GetAssetsReturn r = stub.getAssets(p, auth);
        if (r.getAssetArray()==null || r.getAssetArray().getItems()==null){ System.out.println("(none — array null)"); return; }
        System.out.println("returned assets: " + r.getAssetArray().getItems().length);
        for (Asset a : r.getAssetArray().getItems()) {
            AssetSetInfo si = a.getAssetSetInfo();
            System.out.println("SET name=" + a.getName() + " type=" + a.getType() + " subType=" + a.getSubType());
            System.out.println("  setDefinition=" + (si==null? "(null)" : si.getSetDefinition()));
        }
    }
}
